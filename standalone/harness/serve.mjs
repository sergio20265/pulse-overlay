// Local bench for the standalone overlay. Hosts (all loopback, distinct names on purpose):
//   http://localhost:4000      the "client site"
//   http://127.0.0.1:4000      the "ARVEXA API" (serves standalone/dist)
//   http://127.0.0.3:4000      a "vendor" (sync slow.js, vendor.js that injects the hanging tag)
//   https://127.0.0.2:9443     a host that accepts TCP and never answers (like app.getreview.io)
// Build first: node tools/build-standalone.mjs --api http://127.0.0.1:4000 --portal none
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');

createTcpServer((socket) => {
	socket.on('error', () => {});
	// Swallow the TLS ClientHello and never reply.
}).listen(9443, () => console.log('hanging TLS host on :9443'));

const VENDOR_JS = `
(function () {
	var t = performance.now();
	while (performance.now() - t < 300) {} // CPU-heavy vendor work
	var s = document.createElement('script');
	s.async = true;
	s.src = 'https://127.0.0.2:9443/tags/x/sdk.js';
	document.head.appendChild(s);
})();
`;

createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	const host = (req.headers.host || '').split(':')[0];
	const send = (type, body) => {
		res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
		res.end(body);
	};
	if (host === '127.0.0.3' && url.pathname === '/vendor.js') {
		return send('text/javascript', VENDOR_JS);
	}
	if (host === '127.0.0.3' && url.pathname === '/slow.js') {
		return setTimeout(() => send('text/javascript', '/* slow sync script */'), 1500);
	}
	if (host === '127.0.0.1' && url.pathname.startsWith('/perf/')) {
		const file = normalize(join(dist, url.pathname.replace(/^\/perf\//, '')));
		if (!file.startsWith(dist) || !existsSync(file)) {
			res.writeHead(404);
			return res.end();
		}
		return send(file.endsWith('.css') ? 'text/css' : 'text/javascript', readFileSync(file));
	}
	if (host === 'localhost' && url.pathname === '/') {
		const snippet = readFileSync(join(dist, 'snippet.html'), 'utf8');
		return send('text/html; charset=utf-8', readFileSync(join(here, 'index.html'), 'utf8').replace('<!--SNIPPET-->', snippet));
	}
	res.writeHead(404);
	res.end();
}).listen(4000, () => console.log('open http://localhost:4000/?arvexa=1'));

# ARVEXA Perf Standalone Overlay — Implementation Plan (A: overlay repo)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone (non-WordPress) bundle of the Arvexa Performance Overlay with a new "Third-party requests" section that finds hanging, render-blocking and CPU-heavy third-party requests and their initiators, enabled by an inline snippet the client pastes into `<head>`.

**Architecture:** An inline loader (pasted by the client, first in `<head>`) does nothing unless `?arvexa=1`/cookie is present; when enabled it records every inserted `script/iframe/img/link` (initiator stack, load/error state) into `window.__arvexaPerf` and async-loads the bundle from portal.arvexa.ru. The bundle = Russian dictionary + prelude config + the unchanged-in-spirit overlay core (small standalone switches) + pure analysis library (`third-party-core.js`, Node-tested) + the panel section. `tools/build-standalone.mjs` minifies everything with esbuild and copies it into the portal repo.

**Tech Stack:** Plain ES5 browser JS (matches the core), Node 24 built-in test runner (`node --test`), esbuild 0.25.0 via `npx` for minification. No new dependencies in the plugin.

**Spec:** `docs/superpowers/specs/2026-10-15-arvexa-perf-standalone-design.md`. Companion plan B (portal): `docs/superpowers/plans/2026-10-15-arvexa-perf-portal.md`.

## Global Constraints

- The WordPress plugin is published on wp.org: every core change must keep WP behaviour identical when `config.standalone` is not set.
- Code comments in English only; Russian text only in `standalone/src/i18n-ru.js` (i18n content).
- All user-visible strings in the core and the section go through `__('English source')`; English strings must not contain `'` (keeps the dictionary test regex simple).
- Browser code is ES5 (no arrow functions, `let/const`, template literals) — same as `assets/arvexa-performance-overlay.js`.
- Nothing in the loader or bundle may break the host page: every hook body in `try/catch`, original DOM methods always called with original arguments and return values.
- Loader for normal visitors: zero work beyond reading `location.search` and `document.cookie`.
- Snippet version constant: `1`. Pending threshold: 5000 ms. Load-hold threshold: 10000 ms. Loader buffer: 300 records.
- API base (production): `https://portal.arvexa.ru`. Endpoints: `POST /api/perf/probe`, `POST /api/perf/reports` (contracts below).
- `docs/`, `tools/`, `standalone/` never ship to wp.org.
- Working directory for all commands: `G:\работа\arvexa-performance-overlay`, branch `feature/standalone-perf`.

## API contracts (shared with plan B)

`POST /api/perf/probe` body `{ "origin": string, "hosts": string[] (1..30) }` →
`200 { "results": ProbeResult[] }` | `400 { "error": "INVALID" | "BAD_JSON" }` | `429 { "error": "RATE_LIMITED" }`.

```
ProbeResult = {
  host: string, ok: boolean,
  stage: "dns" | "tcp" | "tls" | "http" | "done",
  error: null | "TIMEOUT" | "NXDOMAIN" | "DNS" | "REFUSED" | "RESET" | "TLS" | "HTTP" | "PRIVATE",
  timings: { dns: number|null, tcp: number|null, tls: number|null, ttfb: number|null },
  status: number|null,
  cert: null | { authorized: boolean, daysLeft: number|null, error: string|null },
  cached: boolean
}
```

`POST /api/perf/reports` body `Snapshot` → `201 { "id": string, "url": string }` | `400` | `413 { "error": "TOO_LARGE" }` | `429`.

```
Snapshot = {
  v: 1, loaderVersion: int 0..99, overlayVersion: string<=20,
  page: url (origin+path, no query/hash), ua: string<=400, capturedAt: ISO string,
  vitals: { ttfb, lcp, cls, inp, longTasks, dcl, load },   // numbers or null; cls number; longTasks int
  requests: RequestView[] (<=150), hosts: HostGroup[] (<=60), cpu: {host, ms}[] (<=30),
  probe: ProbeResult[] (<=30) | null
}
RequestView = { url, host, type: "script"|"iframe"|"img"|"link", source: "html"|"script",
  initiator: "html"|"inline"|url, chain: string[] (<=10), state: "pending"|"loading"|"done"|"error",
  ageMs, durationMs|null, sizeBytes|null, blocking: boolean }
HostGroup = { host, count, transfer, slowestMs, pending, blocking }
```

## File structure

| File | Responsibility |
|---|---|
| `standalone/src/third-party-core.js` | Pure analysis: URL helpers, initiator from stack, request classification, grouping, CPU attribution, load hold, service directory, snapshot builder. UMD: `module.exports` in Node, `window.ArvexaThirdPartyCore` in browser. |
| `standalone/test/third-party-core.test.js` | Node tests for the above. |
| `standalone/src/loader.js` | Inline snippet source: enable switch, DOM insertion hooks, MutationObserver, buffer, async bundle load. |
| `assets/arvexa-performance-overlay.js` | Core: add `config.i18n`, `config.standalone` switches, top-placed sections (`order < 0`). |
| `standalone/src/i18n-ru.js` | `window.__arvexaPerfRu` — Russian dictionary keyed by English source strings. |
| `standalone/src/prelude.js` | Sets `window.ArvexaPerformanceOverlayConfig` for standalone (api, version, i18n). |
| `standalone/src/third-party-section.js` | Panel section + probe/share actions + refresh ticker. |
| `standalone/src/standalone.css` | Button/link styles for the section. |
| `standalone/test/i18n-ru.test.js` | Every visible English string has a Russian translation. |
| `tools/build-standalone.mjs` | Concatenate + minify, hash, pointer `overlay.js`, snippet, copy to portal. |
| `standalone/harness/serve.mjs`, `standalone/harness/index.html` | Local manual test bench: hanging TLS host, sync slow script, CPU-heavy vendor script that injects the hanging tag. |
| `.distignore`, `.gitattributes` | Keep `docs/ tools/ standalone/` out of wp.org packages. |

---

### Task 1: Pure analysis library `third-party-core.js`

**Files:**
- Create: `standalone/src/third-party-core.js`
- Test: `standalone/test/third-party-core.test.js`

**Interfaces:**
- Produces (global `ArvexaThirdPartyCore` / CommonJS export):
  - `LOADER_VERSION: 1`, `PENDING_MS: 5000`, `LOAD_HOLD_MS: 10000`, `SERVICES: {match: string[], name: string, kind: string}[]`
  - `hostOf(url: string): string` — lowercase hostname without port, `''` if not http(s)
  - `stripUrl(url: string): string` — `scheme://host[:port]/path`, no query/hash; `''` if not http(s)
  - `stackUrls(stack: string): string[]` — script URLs in stack order (innermost first), consecutive duplicates removed
  - `pickInitiator(rec, pageUrl): {initiator: 'html'|'inline'|string, chain: string[]}`
  - `classify(recs, entries, now, opts{pendingMs?, selfHosts?, pageUrl?}): RequestView[]` (sorted: pending, error, loading, done; inside a state by duration/age desc)
  - `groupByHost(entries, views, opts{selfHosts?, pageHost?}): HostGroup[]` (sorted: pending desc, slowestMs desc)
  - `cpuByHost(frames, opts{selfHosts?}): {host, ms}[]` (only ≥ 50 ms, desc)
  - `loadHold(readyState, sinceNavMs, views, opts{loadHoldMs?}): null | {sinceMs, pending: RequestView[]}`
  - `lookupService(host): {name, kind} | null`
  - `buildSnapshot(input): Snapshot`
- Loader record shape consumed by `classify`/`pickInitiator` (produced by Task 3):
  `{ url, type, source: 'html'|'script', at, end: number|null, state: 'loading'|'done'|'error', script: string, stack: string, async: boolean|null, head: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `standalone/test/third-party-core.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/third-party-core.js');

const PAGE = 'https://minmagic.ru/oferta?utm_source=x#top';

function rec(over) {
	return Object.assign({
		url: 'https://app.getreview.io/tags/abc/sdk.js',
		type: 'script',
		source: 'script',
		at: 1000,
		end: null,
		state: 'loading',
		script: '',
		stack: '',
		async: true,
		head: true
	}, over);
}

test('hostOf lowercases and drops port, query and non-http urls', () => {
	assert.equal(C.hostOf('https://App.GetReview.io:8443/tags/x/sdk.js?a=1'), 'app.getreview.io');
	assert.equal(C.hostOf('http://mc.yandex.ru/watch/1'), 'mc.yandex.ru');
	assert.equal(C.hostOf('data:image/png;base64,AAAA'), '');
	assert.equal(C.hostOf(''), '');
	assert.equal(C.hostOf(undefined), '');
});

test('stripUrl keeps origin and path only', () => {
	assert.equal(C.stripUrl('https://a.ru/x/y.js?token=1#h'), 'https://a.ru/x/y.js');
	assert.equal(C.stripUrl('https://a.ru'), 'https://a.ru/');
	assert.equal(C.stripUrl('https://a.ru:8443/p?q'), 'https://a.ru:8443/p');
	assert.equal(C.stripUrl('blob:https://a.ru/1'), '');
});

test('stackUrls parses Chrome and Firefox stacks, innermost first', () => {
	const chrome = [
		'Error',
		'    at track (https://minmagic.ru/oferta:12:40)',
		'    at Node.appendChild (https://minmagic.ru/oferta:20:5)',
		'    at r (https://stat1.clickfraud.ru/js/container_y6FzSWjC.js:1:2200)',
		'    at https://stat1.clickfraud.ru/js/container_y6FzSWjC.js:1:900'
	].join('\n');
	assert.deepEqual(C.stackUrls(chrome), [
		'https://minmagic.ru/oferta',
		'https://stat1.clickfraud.ru/js/container_y6FzSWjC.js'
	]);
	const firefox = 'track@https://minmagic.ru/oferta:12:40\nr@https://cdn.example.com:8443/a.js:3:7\n';
	assert.deepEqual(C.stackUrls(firefox), ['https://minmagic.ru/oferta', 'https://cdn.example.com:8443/a.js']);
	assert.deepEqual(C.stackUrls(''), []);
});

test('pickInitiator: html source', () => {
	assert.deepEqual(C.pickInitiator(rec({ source: 'html' }), PAGE), { initiator: 'html', chain: [] });
});

test('pickInitiator: currentScript wins', () => {
	const r = rec({ script: 'https://stat1.clickfraud.ru/js/container.js', stack: 'at x (https://minmagic.ru/oferta:1:1)' });
	assert.equal(C.pickInitiator(r, PAGE).initiator, 'https://stat1.clickfraud.ru/js/container.js');
	assert.deepEqual(C.pickInitiator(r, PAGE).chain, ['stat1.clickfraud.ru']);
});

test('pickInitiator: outermost external frame after dropping loader frames', () => {
	const r = rec({
		stack: [
			'Error',
			'    at track (https://minmagic.ru/oferta:12:40)',
			'    at https://static.tildacdn.com/js/jquery-1.10.2.min.js:4:100',
			'    at https://stat1.clickfraud.ru/js/container.js:1:900'
		].join('\n')
	});
	const ini = C.pickInitiator(r, PAGE);
	assert.equal(ini.initiator, 'https://stat1.clickfraud.ru/js/container.js');
	assert.deepEqual(ini.chain, ['static.tildacdn.com', 'stat1.clickfraud.ru']);
});

test('pickInitiator: inline when the outermost frame is the page itself', () => {
	const r = rec({
		stack: [
			'Error',
			'    at track (https://minmagic.ru/oferta:12:40)',
			'    at https://static.tildacdn.com/js/jquery-1.10.2.min.js:4:100',
			'    at https://minmagic.ru/oferta:300:9'
		].join('\n')
	});
	assert.equal(C.pickInitiator(r, PAGE).initiator, 'inline');
	assert.equal(C.pickInitiator(rec({ stack: '' }), PAGE).initiator, 'inline');
});

test('classify: pending after threshold, loading before it', () => {
	const views = C.classify([rec({ at: 1000 })], [], 7000, { pageUrl: PAGE });
	assert.equal(views[0].state, 'pending');
	assert.equal(views[0].ageMs, 6000);
	assert.equal(C.classify([rec({ at: 1000 })], [], 3000, { pageUrl: PAGE })[0].state, 'loading');
});

test('classify: done via resource entry or load event, error wins', () => {
	const entry = { name: 'https://app.getreview.io/tags/abc/sdk.js', duration: 420.4, transferSize: 2048, encodedBodySize: 0 };
	const v = C.classify([rec()], [entry], 9000, { pageUrl: PAGE })[0];
	assert.equal(v.state, 'done');
	assert.equal(v.durationMs, 420);
	assert.equal(v.sizeBytes, 2048);
	const byEvent = C.classify([rec({ state: 'done', end: 1600 })], [], 9000, { pageUrl: PAGE })[0];
	assert.equal(byEvent.state, 'done');
	assert.equal(byEvent.durationMs, 600);
	assert.equal(C.classify([rec({ state: 'error', end: 1100 })], [entry], 9000, { pageUrl: PAGE })[0].state, 'error');
});

test('classify: skips self hosts, dedupes urls, strips query', () => {
	const views = C.classify([
		rec({ url: 'https://portal.arvexa.ru/perf/overlay.js' }),
		rec({ url: 'https://a.ru/x.js?t=1' }),
		rec({ url: 'https://a.ru/x.js?t=1', at: 2000 })
	], [], 3000, { selfHosts: ['portal.arvexa.ru'], pageUrl: PAGE });
	assert.equal(views.length, 1);
	assert.equal(views[0].url, 'https://a.ru/x.js');
});

test('classify: blocking = sync html script in head, or renderBlockingStatus', () => {
	const sync = rec({ url: 'https://s3.intickets.ru/intickets.js', source: 'html', async: false, head: true, state: 'done', end: 1500 });
	const asyncHtml = rec({ url: 'https://b.ru/a.js', source: 'html', async: true, head: true, state: 'done', end: 1500 });
	const css = rec({ url: 'https://c.ru/s.css', type: 'link', source: 'html', async: null, state: 'done', end: 1500 });
	const entries = [{ name: 'https://c.ru/s.css', duration: 100, transferSize: 10, renderBlockingStatus: 'blocking' }];
	const views = C.classify([sync, asyncHtml, css], entries, 9000, { pageUrl: PAGE });
	const by = {};
	views.forEach(function (v) { by[v.host] = v.blocking; });
	assert.deepEqual(by, { 's3.intickets.ru': true, 'b.ru': false, 'c.ru': true });
});

test('classify: sorts pending first, then error, loading, done', () => {
	const views = C.classify([
		rec({ url: 'https://done.ru/a.js', state: 'done', end: 1100 }),
		rec({ url: 'https://err.ru/a.js', state: 'error', end: 1100 }),
		rec({ url: 'https://hang.ru/a.js', at: 0 }),
		rec({ url: 'https://load.ru/a.js', at: 8000 })
	], [], 9000, { pageUrl: PAGE });
	assert.deepEqual(views.map(function (v) { return v.state; }), ['pending', 'error', 'loading', 'done']);
});

test('groupByHost merges resource entries with pending views', () => {
	const entries = [
		{ name: 'https://mc.yandex.ru/metrika/tag.js', duration: 300, transferSize: 90000 },
		{ name: 'https://mc.yandex.ru/watch/1', duration: 120, transferSize: 0 },
		{ name: 'https://portal.arvexa.ru/perf/overlay.js', duration: 50, transferSize: 100 }
	];
	const views = [{ host: 'app.getreview.io', state: 'pending', ageMs: 34000, blocking: false }];
	const groups = C.groupByHost(entries, views, { selfHosts: ['portal.arvexa.ru'], pageHost: 'minmagic.ru' });
	assert.equal(groups[0].host, 'app.getreview.io');
	assert.equal(groups[0].pending, 1);
	assert.equal(groups[0].slowestMs, 34000);
	assert.deepEqual(groups[1], { host: 'mc.yandex.ru', count: 2, transfer: 90000, slowestMs: 300, pending: 0, blocking: 0 });
	assert.equal(groups.length, 2);
});

test('cpuByHost sums script time from long animation frames', () => {
	const frames = [
		{ scripts: [{ sourceURL: 'https://mc.yandex.ru/metrika/tag.js', duration: 180 }, { sourceURL: '', duration: 30 }] },
		{ scripts: [{ sourceURL: 'https://mc.yandex.ru/metrika/tag.js', duration: 90 }, { sourceURL: 'https://portal.arvexa.ru/x.js', duration: 400 }] }
	];
	assert.deepEqual(C.cpuByHost(frames, { selfHosts: ['portal.arvexa.ru'] }), [{ host: 'mc.yandex.ru', ms: 270 }]);
	assert.deepEqual(C.cpuByHost([], {}), []);
});

test('loadHold reports pending requests only after the threshold', () => {
	const views = [{ host: 'app.getreview.io', state: 'pending' }, { host: 'a.ru', state: 'done' }];
	assert.equal(C.loadHold('complete', 30000, views), null);
	assert.equal(C.loadHold('interactive', 9000, views), null);
	const hold = C.loadHold('interactive', 34000, views);
	assert.equal(hold.sinceMs, 34000);
	assert.deepEqual(hold.pending.map(function (v) { return v.host; }), ['app.getreview.io']);
});

test('lookupService matches host or subdomain, not lookalikes', () => {
	assert.equal(C.lookupService('app.getreview.io').name, 'GetReview');
	assert.equal(C.lookupService('getreview.io').name, 'GetReview');
	assert.equal(C.lookupService('notgetreview.io'), null);
	assert.equal(C.lookupService('mc.yandex.ru').name, 'Yandex Metrica');
});

test('buildSnapshot strips queries and caps lists', () => {
	const views = [];
	for (let i = 0; i < 200; i++) {
		views.push({ url: 'https://a.ru/' + i + '.js?t=1', host: 'a.ru', type: 'script', source: 'script', initiator: 'https://b.ru/x.js?k=2', chain: ['b.ru'], state: 'done', ageMs: 1, durationMs: 1, sizeBytes: null, blocking: false });
	}
	const snap = C.buildSnapshot({
		loaderVersion: 1, overlayVersion: '0.3.0', pageUrl: PAGE, ua: 'UA', capturedAt: '2026-10-15T10:00:00.000Z',
		vitals: { ttfb: 120.55, lcp: 2400, cls: 0.01234, inp: null, longTasks: 3, lcpEntry: {} },
		dcl: 900, load: null, views: views, hosts: [], cpu: [], probe: null
	});
	assert.equal(snap.v, 1);
	assert.equal(snap.page, 'https://minmagic.ru/oferta');
	assert.equal(snap.requests.length, 150);
	assert.equal(snap.requests[0].url, 'https://a.ru/0.js');
	assert.equal(snap.requests[0].initiator, 'https://b.ru/x.js');
	assert.deepEqual(snap.vitals, { ttfb: 120.55, lcp: 2400, cls: 0.012, inp: null, longTasks: 3, dcl: 900, load: null });
	assert.equal(snap.probe, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test standalone/test/`
Expected: FAIL — `Cannot find module '../src/third-party-core.js'`.

- [ ] **Step 3: Implement `standalone/src/third-party-core.js`**

```js
/**
 * ARVEXA Perf — third-party request analysis.
 *
 * Pure functions with no DOM access: the overlay section feeds them the
 * loader buffer and Performance entries, Node tests feed them fixtures.
 * UMD wrapper: CommonJS in Node, window.ArvexaThirdPartyCore in browsers.
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.ArvexaThirdPartyCore = factory();
	}
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	var LOADER_VERSION = 1;
	var PENDING_MS = 5000;
	var LOAD_HOLD_MS = 10000;

	// Display names/kinds are English source strings, translated by the section.
	var SERVICES = [
		{ match: ['mc.yandex.ru', 'mc.yandex.com', 'mc.webvisor.org', 'mc.webvisor.com'], name: 'Yandex Metrica', kind: 'analytics' },
		{ match: ['getreview.io'], name: 'GetReview', kind: 'review widget' },
		{ match: ['intickets.ru'], name: 'Intickets', kind: 'ticket sales' },
		{ match: ['clickfraud.ru'], name: 'Clickfraud', kind: 'click-fraud protection, tag manager' },
		{ match: ['mango-office.ru'], name: 'Mango Office', kind: 'call tracking' },
		{ match: ['tildacdn.com', 'tilda.ws', 'tildaapi.com'], name: 'Tilda', kind: 'site builder' },
		{ match: ['top-fwz1.mail.ru', 'top.mail.ru'], name: 'Top@Mail.ru', kind: 'analytics' },
		{ match: ['vk.com', 'vk.ru', 'userapi.com'], name: 'VK', kind: 'social widgets, pixel' },
		{ match: ['googletagmanager.com'], name: 'Google Tag Manager', kind: 'tag manager' },
		{ match: ['google-analytics.com'], name: 'Google Analytics', kind: 'analytics' },
		{ match: ['fonts.googleapis.com', 'fonts.gstatic.com'], name: 'Google Fonts', kind: 'fonts' },
		{ match: ['cdn.jsdelivr.net'], name: 'jsDelivr', kind: 'public CDN' },
		{ match: ['jivosite.com', 'jivo.ru', 'jivosite.ru'], name: 'Jivo', kind: 'online chat' },
		{ match: ['servicepipe.tech'], name: 'ServicePipe', kind: 'anti-bot protection' },
		{ match: ['smartcaptcha.yandexcloud.net'], name: 'Yandex SmartCaptcha', kind: 'captcha' }
	];

	function hostOf(url) {
		var m = /^https?:\/\/([^\/?#:]+)/i.exec(String(url || ''));
		return m ? m[1].toLowerCase() : '';
	}

	function stripUrl(url) {
		var m = /^(https?:\/\/[^\/?#]+)([^?#]*)/i.exec(String(url || ''));
		return m ? m[1] + (m[2] || '/') : '';
	}

	function stackUrls(stack) {
		var out = [];
		// Chrome: "at fn (URL:line:col)" / "at URL:line:col"; Firefox/Safari: "fn@URL:line:col".
		var re = /(https?:\/\/[^\s()'"@]+):\d+:\d+/g;
		var m;
		while ((m = re.exec(String(stack || '')))) {
			if (out[out.length - 1] !== m[1]) {
				out.push(m[1]);
			}
		}
		return out;
	}

	function pickInitiator(rec, pageUrl) {
		if (rec.source === 'html') {
			return { initiator: 'html', chain: [] };
		}
		var page = stripUrl(pageUrl);
		var urls = stackUrls(rec.stack);
		// The innermost frames are the loader hook itself (inline on the page).
		while (urls.length && stripUrl(urls[0]) === page) {
			urls.shift();
		}
		var chain = [];
		function addHost(u) {
			var h = hostOf(u);
			if (h && stripUrl(u) !== page && chain.indexOf(h) === -1) {
				chain.push(h);
			}
		}
		urls.forEach(addHost);
		// document.currentScript is exact for top-level execution of an external file.
		if (rec.script) {
			addHost(rec.script);
			return { initiator: rec.script, chain: chain };
		}
		var outer = urls[urls.length - 1];
		if (!outer || stripUrl(outer) === page) {
			return { initiator: 'inline', chain: chain };
		}
		return { initiator: outer, chain: chain };
	}

	var STATE_RANK = { pending: 0, error: 1, loading: 2, done: 3 };

	function weight(v) {
		return v.durationMs !== null ? v.durationMs : v.ageMs;
	}

	function classify(recs, entries, now, opts) {
		opts = opts || {};
		var pendingMs = opts.pendingMs || PENDING_MS;
		var self = opts.selfHosts || [];
		var byName = {};
		(entries || []).forEach(function (e) {
			byName[e.name] = e;
		});
		var seen = {};
		var out = [];
		(recs || []).forEach(function (r) {
			var host = hostOf(r.url);
			var url = stripUrl(r.url);
			if (!host || self.indexOf(host) !== -1 || seen[url]) {
				return;
			}
			seen[url] = true;
			var e = byName[r.url] || null;
			var state;
			if (r.state === 'error') {
				state = 'error';
			} else if (r.state === 'done' || e) {
				state = 'done';
			} else {
				state = now - r.at >= pendingMs ? 'pending' : 'loading';
			}
			var ini = pickInitiator(r, opts.pageUrl || '');
			var hasEnd = r.end !== null && r.end !== undefined;
			out.push({
				url: url,
				host: host,
				type: r.type,
				source: r.source,
				initiator: ini.initiator === 'html' || ini.initiator === 'inline' ? ini.initiator : stripUrl(ini.initiator),
				chain: ini.chain,
				state: state,
				ageMs: Math.max(0, Math.round(now - r.at)),
				durationMs: e ? Math.round(e.duration) : hasEnd ? Math.round(r.end - r.at) : null,
				sizeBytes: e ? e.transferSize || e.encodedBodySize || null : null,
				blocking: !!(
					(e && e.renderBlockingStatus === 'blocking') ||
					(r.type === 'script' && r.source === 'html' && r.head && r.async === false)
				)
			});
		});
		out.sort(function (a, b) {
			return STATE_RANK[a.state] - STATE_RANK[b.state] || weight(b) - weight(a);
		});
		return out;
	}

	function groupByHost(entries, views, opts) {
		opts = opts || {};
		var self = opts.selfHosts || [];
		var map = {};
		function get(h) {
			if (!map[h]) {
				map[h] = { host: h, count: 0, transfer: 0, slowestMs: 0, pending: 0, blocking: 0 };
			}
			return map[h];
		}
		(entries || []).forEach(function (e) {
			var h = hostOf(e.name);
			if (!h || self.indexOf(h) !== -1) {
				return;
			}
			var g = get(h);
			g.count++;
			g.transfer += e.transferSize || 0;
			g.slowestMs = Math.max(g.slowestMs, Math.round(e.duration || 0));
		});
		(views || []).forEach(function (v) {
			if (!v.host || self.indexOf(v.host) !== -1) {
				return;
			}
			var g = get(v.host);
			if (v.state === 'pending' || v.state === 'loading') {
				g.slowestMs = Math.max(g.slowestMs, v.ageMs);
				if (v.state === 'pending') {
					g.pending++;
				}
			}
			if (v.blocking) {
				g.blocking++;
			}
		});
		return Object.keys(map)
			.map(function (k) { return map[k]; })
			.sort(function (a, b) { return b.pending - a.pending || b.slowestMs - a.slowestMs; });
	}

	function cpuByHost(frames, opts) {
		var self = (opts && opts.selfHosts) || [];
		var map = {};
		(frames || []).forEach(function (f) {
			(f.scripts || []).forEach(function (s) {
				var h = hostOf(s.sourceURL) || 'inline';
				if (self.indexOf(h) !== -1) {
					return;
				}
				map[h] = (map[h] || 0) + (s.duration || 0);
			});
		});
		return Object.keys(map)
			.map(function (h) { return { host: h, ms: Math.round(map[h]) }; })
			.filter(function (x) { return x.ms >= 50; })
			.sort(function (a, b) { return b.ms - a.ms; });
	}

	function loadHold(readyState, sinceNavMs, views, opts) {
		var limit = (opts && opts.loadHoldMs) || LOAD_HOLD_MS;
		if (readyState === 'complete' || sinceNavMs < limit) {
			return null;
		}
		return {
			sinceMs: Math.round(sinceNavMs),
			pending: (views || []).filter(function (v) { return v.state === 'pending' || v.state === 'loading'; })
		};
	}

	function lookupService(host) {
		host = String(host || '').toLowerCase();
		for (var i = 0; i < SERVICES.length; i++) {
			for (var j = 0; j < SERVICES[i].match.length; j++) {
				var m = SERVICES[i].match[j];
				if (host === m || host.slice(-(m.length + 1)) === '.' + m) {
					return { name: SERVICES[i].name, kind: SERVICES[i].kind };
				}
			}
		}
		return null;
	}

	function num(x) {
		return typeof x === 'number' && isFinite(x) ? Math.round(x * 1000) / 1000 : null;
	}

	function buildSnapshot(input) {
		var v = input.vitals || {};
		return {
			v: 1,
			loaderVersion: input.loaderVersion || 0,
			overlayVersion: String(input.overlayVersion || '').slice(0, 20),
			page: stripUrl(input.pageUrl),
			ua: String(input.ua || '').slice(0, 400),
			capturedAt: String(input.capturedAt || ''),
			vitals: {
				ttfb: num(v.ttfb),
				lcp: num(v.lcp),
				cls: num(v.cls) || 0,
				inp: num(v.inp),
				longTasks: v.longTasks || 0,
				dcl: num(input.dcl),
				load: num(input.load)
			},
			requests: (input.views || []).slice(0, 150).map(function (r) {
				return {
					url: stripUrl(r.url),
					host: r.host,
					type: r.type,
					source: r.source,
					initiator: r.initiator === 'html' || r.initiator === 'inline' ? r.initiator : stripUrl(r.initiator),
					chain: (r.chain || []).slice(0, 10),
					state: r.state,
					ageMs: r.ageMs,
					durationMs: r.durationMs,
					sizeBytes: r.sizeBytes,
					blocking: r.blocking
				};
			}),
			hosts: (input.hosts || []).slice(0, 60),
			cpu: (input.cpu || []).slice(0, 30),
			probe: input.probe ? input.probe.slice(0, 30) : null
		};
	}

	return {
		LOADER_VERSION: LOADER_VERSION,
		PENDING_MS: PENDING_MS,
		LOAD_HOLD_MS: LOAD_HOLD_MS,
		SERVICES: SERVICES,
		hostOf: hostOf,
		stripUrl: stripUrl,
		stackUrls: stackUrls,
		pickInitiator: pickInitiator,
		classify: classify,
		groupByHost: groupByHost,
		cpuByHost: cpuByHost,
		loadHold: loadHold,
		lookupService: lookupService,
		buildSnapshot: buildSnapshot
	};
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test standalone/test/`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add standalone/src/third-party-core.js standalone/test/third-party-core.test.js
git commit -m "feat(standalone): third-party request analysis library"
```

---

### Task 2: Core standalone switches

**Files:**
- Modify: `assets/arvexa-performance-overlay.js` (lines ~17, 688–691, 771–773, 989–999, 1078–1084, 1123–1139)

**Interfaces:**
- Consumes config keys: `config.i18n: {__, sprintf}`, `config.standalone: boolean`.
- Produces: `registerSection(id, render, order)` — `order < 0` renders at the top of the panel (before Network), `order >= 0` at the bottom (unchanged).

No unit harness exists for the browser core; verification is the harness in Task 4 and WP regression in Task 6.

- [ ] **Step 1: i18n from config**

Replace line 17:

```js
	var i18n = (window.wp && window.wp.i18n) || {};
```

with:

```js
	// Standalone builds pass their own translator; WP uses wp-i18n.
	var i18n = config.i18n || (window.wp && window.wp.i18n) || {};
```

- [ ] **Step 2: Top-placed extra sections**

In `renderPanel()` replace:

```js
		var html = pulseDashboard();
```

with:

```js
		var html = pulseDashboard() + renderExtraSections(true);
```

Replace the block

```js
		// Sections registered by add-ons via window.ArvexaPerformanceOverlay.registerSection().
		extraSections
			.slice()
			.sort(function (a, b) { return a.order - b.order; })
			.forEach(function (s) {
				try {
					html += s.render(server, vitals) || '';
				} catch (e) {
					/* an add-on must never break the panel */
				}
			});
```

with:

```js
		html += renderExtraSections(false);
```

Add right after `function section(...) {...}`:

```js
	// Sections registered via window.ArvexaPerformanceOverlay.registerSection().
	// order < 0 goes above the built-in sections, the rest below them.
	function renderExtraSections(top) {
		var out = '';
		extraSections
			.filter(function (s) { return top ? s.order < 0 : s.order >= 0; })
			.sort(function (a, b) { return a.order - b.order; })
			.forEach(function (s) {
				try {
					out += s.render(server, vitals) || '';
				} catch (e) {
					/* an add-on must never break the panel */
				}
			});
		return out;
	}
```

In `registerSection`, keep `order || 100` but allow negatives: replace

```js
			extraSections.push({ id: id, render: render, order: order || 100 });
```

with

```js
			extraSections.push({ id: id, render: render, order: typeof order === 'number' ? order : 100 });
```

- [ ] **Step 3: No "No server data" hint in standalone**

Replace:

```js
		} else {
			html += '<div class="po-hint">' + esc(__('No server data on this page.', 'arvexa-performance-overlay')) + '</div>';
		}
```

with:

```js
		} else if (!config.standalone) {
			html += '<div class="po-hint">' + esc(__('No server data on this page.', 'arvexa-performance-overlay')) + '</div>';
		}
```

- [ ] **Step 4: Open the panel on first standalone run**

In `build()` replace:

```js
		var open = false;
		try {
			open = localStorage.getItem(LS_KEY) === '1';
		} catch (e) { /* private mode */ }
```

with:

```js
		var open = false;
		try {
			var stored = localStorage.getItem(LS_KEY);
			// Standalone users arrive via ?arvexa=1 to look at the panel, so open it unless they closed it before.
			open = stored === '1' || (stored === null && !!config.standalone);
		} catch (e) { /* private mode */ }
```

- [ ] **Step 5: Skip WP-only machinery in standalone**

In `init()` replace:

```js
			build();
			watchServerData();
			armSampling();
			initNetSpy();
```

with:

```js
			build();
			// Server JSON polling, history beacons and the WP AJAX spy only make sense inside WordPress.
			if (!config.standalone) {
				watchServerData();
				armSampling();
				initNetSpy();
			}
```

- [ ] **Step 6: Syntax check**

Run: `node --check assets/arvexa-performance-overlay.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add assets/arvexa-performance-overlay.js
git commit -m "feat(core): standalone mode, config translator, top-placed sections"
```

---

### Task 3: Inline loader

**Files:**
- Create: `standalone/src/loader.js`

**Interfaces:**
- Produces `window.__arvexaPerf = { v: 1, api: string, q: Record[] }` (Record shape — see Task 1 Interfaces).
- Placeholder `__ARVEXA_API__` is replaced by the build (Task 4).
- Loads `<api>/perf/overlay.js` async when enabled.

Verification happens in the Task 4 harness (DOM-heavy code; a fake DOM would test the fake).

- [ ] **Step 1: Write `standalone/src/loader.js`**

```js
/* ARVEXA Perf loader v1 — paste as the FIRST script inside <head>. */
(function (w, d) {
	'use strict';

	var VERSION = 1;
	var API = '__ARVEXA_API__';
	var MAX = 300;

	if (w.__arvexaPerf) {
		return;
	}

	// Enable switch: ?arvexa=1 turns diagnostics on for 7 days, ?arvexa=0 turns it off.
	var m = /[?&]arvexa=([01])(?:&|$)/.exec(w.location.search);
	try {
		if (m) {
			d.cookie = 'arvexa_perf=' + (m[1] === '1' ? '1; max-age=604800' : '; max-age=0') + '; path=/; SameSite=Lax';
		}
	} catch (e) { /* cookies blocked */ }
	var on = m ? m[1] === '1' : /(?:^|;\s*)arvexa_perf=1/.test(d.cookie || '');
	if (!on) {
		return;
	}

	var st = (w.__arvexaPerf = { v: VERSION, api: API, q: [] });
	var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
	var now = function () {
		return w.performance && performance.now ? performance.now() : 0;
	};

	// Only elements that fire load/error are tracked, otherwise they would look "hanging" forever.
	function urlAttr(el) {
		var t = el.tagName;
		if (t === 'SCRIPT' || t === 'IFRAME' || t === 'IMG') {
			return el.getAttribute('loading') === 'lazy' ? '' : 'src';
		}
		if (t === 'LINK' && /(^|\s)(stylesheet|preload|modulepreload)(\s|$)/i.test(el.rel || '')) {
			return 'href';
		}
		return '';
	}

	function track(el, source, parent) {
		try {
			if (!el || el.nodeType !== 1) {
				return;
			}
			var a = urlAttr(el);
			if (!a || (seen && seen.has(el))) {
				return;
			}
			var url = el[a];
			if (typeof url !== 'string' || !/^https?:/i.test(url)) {
				return;
			}
			if (seen) {
				seen.add(el);
			}
			if (st.q.length >= MAX) {
				return;
			}
			var cs = d.currentScript;
			var r = {
				url: url,
				type: el.tagName.toLowerCase(),
				source: source,
				at: now(),
				end: null,
				state: 'loading',
				script: source === 'script' && cs && cs.src ? cs.src : '',
				stack: source === 'script' ? String(new Error().stack || '').slice(0, 3000) : '',
				async: el.tagName === 'SCRIPT' ? !!(el.async || el.defer || el.type === 'module') : null,
				head: !!(parent && parent.nodeName === 'HEAD')
			};
			el.addEventListener('load', function () {
				r.state = 'done';
				r.end = now();
			});
			el.addEventListener('error', function () {
				r.state = 'error';
				r.end = now();
			});
			st.q.push(r);
		} catch (e) { /* never break the page */ }
	}

	// firstOnly: insertBefore/replaceChild — the 2nd argument is an existing node.
	// siblingApi: after/before/replaceWith — the new node's parent is this.parentNode.
	function wrap(proto, name, firstOnly, siblingApi) {
		var orig = proto && proto[name];
		if (typeof orig !== 'function') {
			return;
		}
		proto[name] = function () {
			try {
				var parent = siblingApi ? this.parentNode : this;
				var n = firstOnly ? 1 : arguments.length;
				for (var i = 0; i < n; i++) {
					var node = arguments[i];
					if (node && node.nodeType === 11) {
						for (var c = node.firstChild; c; c = c.nextSibling) {
							track(c, 'script', parent);
						}
					} else {
						track(node, 'script', parent);
					}
				}
			} catch (e) { /* never break the caller */ }
			return orig.apply(this, arguments);
		};
	}

	wrap(Node.prototype, 'appendChild', true, false);
	wrap(Node.prototype, 'insertBefore', true, false);
	wrap(Node.prototype, 'replaceChild', true, false);
	wrap(Element.prototype, 'append', false, false);
	wrap(Element.prototype, 'prepend', false, false);
	wrap(Element.prototype, 'after', false, true);
	wrap(Element.prototype, 'before', false, true);
	wrap(Element.prototype, 'replaceWith', false, true);

	// Tags from the page HTML (and innerHTML/document.write) bypass the hooks above.
	var SEL = 'script[src],iframe[src],img[src],link[href]';
	try {
		new MutationObserver(function (list) {
			for (var i = 0; i < list.length; i++) {
				var added = list[i].addedNodes;
				for (var j = 0; j < added.length; j++) {
					var n = added[j];
					if (n.nodeType !== 1) {
						continue;
					}
					track(n, 'html', n.parentNode);
					if (n.firstElementChild && n.querySelectorAll) {
						var inner = n.querySelectorAll(SEL);
						for (var k = 0; k < inner.length; k++) {
							track(inner[k], 'html', inner[k].parentNode);
						}
					}
				}
			}
		}).observe(d.documentElement, { childList: true, subtree: true });
	} catch (e) { /* very old browser */ }

	var s = d.createElement('script');
	s.async = true;
	s.src = API + '/perf/overlay.js';
	(d.head || d.documentElement).appendChild(s);
})(window, document);
```

- [ ] **Step 2: Syntax check**

Run: `node --check standalone/src/loader.js`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add standalone/src/loader.js
git commit -m "feat(standalone): inline loader with insertion hooks"
```

---

### Task 4: Prelude, Russian dictionary, styles, build tool and harness

**Files:**
- Create: `standalone/src/prelude.js`, `standalone/src/i18n-ru.js`, `standalone/src/standalone.css`, `tools/build-standalone.mjs`, `standalone/harness/serve.mjs`, `standalone/harness/index.html`
- Modify: `.gitignore` (add `standalone/dist/`)

**Interfaces:**
- Consumes: Task 1 core lib, Task 2 core switches, Task 3 loader.
- Produces:
  - `window.ArvexaPerformanceOverlayConfig = { standalone: true, api, version, loaderVersion: 1, i18n: {__, sprintf} }`
  - `window.__arvexaPerfRu: Record<string, string>`
  - Build CLI: `node tools/build-standalone.mjs [--api <url>] [--portal <path>|none]` → `standalone/dist/{overlay.js, static/overlay.<hash>.js, static/overlay.<hash>.css, snippet.html}`; with a portal path also writes `<portal>/public/perf/overlay.js`, `<portal>/public/perf/static/*`, `<portal>/src/lib/perf/snippet.generated.ts` exporting `PERF_SNIPPET`, `PERF_LOADER_VERSION`, `PERF_OVERLAY_VERSION`.

- [ ] **Step 1: `standalone/src/prelude.js`**

```js
/**
 * ARVEXA Perf standalone prelude: configures the shared overlay core before
 * it evaluates (the core reads ArvexaPerformanceOverlayConfig at load time).
 * __ARVEXA_API__ / __ARVEXA_VERSION__ are replaced by tools/build-standalone.mjs.
 */
(function () {
	'use strict';

	var dict = window.__arvexaPerfRu || {};
	var has = Object.prototype.hasOwnProperty;

	window.ArvexaPerformanceOverlayConfig = {
		standalone: true,
		api: '__ARVEXA_API__',
		version: '__ARVEXA_VERSION__',
		loaderVersion: 1,
		i18n: {
			__: function (text) {
				return has.call(dict, text) ? dict[text] : text;
			},
			sprintf: function (fmt) {
				var args = arguments;
				return String(fmt).replace(/%([1-9])\$s/g, function (_, n) {
					return args[+n];
				});
			}
		}
	};
})();
```

- [ ] **Step 2: `standalone/src/i18n-ru.js`** (core strings visible in standalone + all section strings from Task 5; Task 5's dictionary test enforces completeness)

```js
/* Russian strings for the standalone ARVEXA Perf build. Keys are the English source strings. */
window.__arvexaPerfRu = {
	// Core panel
	'Arvexa Performance Overlay': 'ARVEXA Perf — диагностика скорости',
	'Network': 'Сеть',
	'TTFB': 'Ответ сервера (TTFB)',
	'Requests': 'Запросов',
	'Transferred': 'Загружено',
	'from cache': 'из кэша',
	'Network bytes; cached responses count as 0': 'Байты из сети; ответы из кэша считаются как 0',
	'Rendering': 'Отрисовка',
	'LCP': 'LCP',
	'LCP element': 'Элемент LCP',
	'Largest Contentful Paint element': 'Самый крупный элемент первого экрана',
	'CLS': 'CLS',
	'INP': 'INP',
	'Worst interaction so far': 'Самая медленная реакция на действие',
	'DOM nodes': 'Элементов DOM',
	'Long tasks': 'Долгих задач',
	'Components': 'Компоненты',
	'LCP image has loading="lazy" — the browser waits for layout before fetching it. Remove lazy-loading from this image.': 'У главной картинки стоит loading="lazy" — браузер начинает её грузить слишком поздно. Уберите ленивую загрузку с этой картинки.',
	'LCP image is a CSS background — it is discovered only after the stylesheet loads. Use an <img> or preload it.': 'Главная картинка задана фоном в CSS — браузер узнаёт о ней только после загрузки стилей. Используйте <img> или preload.',
	'LCP image has no fetchpriority="high" — it competes with other images for bandwidth.': 'У главной картинки нет fetchpriority="high" — она делит канал с остальными картинками.',
	'Image is %1$spx wide but only %2$spx is needed — check srcset/sizes or the image size used by the theme.': 'Картинка шириной %1$spx, а нужно только %2$spx — уменьшите её или настройте srcset/sizes.',
	'LCP file weighs %1$s — compress it.': 'Главная картинка весит %1$s — сожмите её.',
	'LCP image is not WebP/AVIF — a modern format is usually 30–50% smaller.': 'Главная картинка не в WebP/AVIF — современный формат обычно легче на 30–50%.',
	'The LCP image starts downloading late — it is not in the initial HTML or is injected by JavaScript (slider, lazy-load script). Preload it.': 'Главная картинка начинает грузиться поздно — её вставляет скрипт (слайдер, ленивая загрузка). Добавьте preload.',
	'Long gap between loading and painting — render-blocking CSS/JS, a web font, or a script revealing the content (animations, sliders).': 'Картинка загрузилась, но долго не показывается — мешают блокирующие CSS/JS, шрифт или анимация появления.',
	'Most of LCP is waiting for the server — see PHP time and SQL above, or enable page caching.': 'Большую часть времени страница ждёт сервер — включите кэширование страниц или ускорьте хостинг.',

	// Third-party section
	'The ARVEXA Perf snippet was not found in <head> — hanging requests and their initiators are unavailable. Paste the snippet as the first script in <head>.': 'Код вставки ARVEXA Perf не найден в <head> — зависшие запросы и их источники недоступны. Вставьте код первым скриптом в <head>.',
	'The snippet on this site is outdated — copy the new one from portal.arvexa.ru/perf.': 'Код вставки на сайте устарел — скопируйте новый на portal.arvexa.ru/perf.',
	'Page load': 'Загрузка страницы',
	'DOM ready': 'Страница построена',
	'Fully loaded': 'Полностью загружена',
	'not yet': 'ещё нет',
	'The page has been loading for %1$s. Holding it: %2$s': 'Страница грузится уже %1$s. Держат загрузку: %2$s',
	'unknown requests': 'неизвестные запросы',
	'Not responding': 'Не отвечают',
	'hangs %1$s': 'висит %1$s',
	'failed': 'ошибка',
	'Block rendering': 'Блокируют отрисовку',
	'Domains': 'Домены',
	'req': 'запр.',
	'site': 'сайт',
	'CPU load by script': 'Нагрузка на процессор',
	'this site (inline code)': 'этот сайт (встроенный код)',
	'Main-thread time in long animation frames': 'Время основного потока в долгих кадрах',
	'This browser does not report which scripts load the CPU — open the page in Chrome or Edge.': 'Этот браузер не сообщает, какие скрипты грузят процессор — откройте страницу в Chrome или Edge.',
	'Check': 'Проверка',
	'Check from ARVEXA server': 'Проверить с сервера ARVEXA',
	'Checking…': 'Проверяю…',
	'Share report': 'Поделиться отчётом',
	'Saving…': 'Сохраняю…',
	'Report link (valid 30 days):': 'Ссылка на отчёт (действует 30 дней):',
	'No third-party domains to check.': 'Нет сторонних доменов для проверки.',
	'Too many checks — try again in a few minutes.': 'Слишком много проверок — попробуйте через несколько минут.',
	'The ARVEXA server refused the check.': 'Сервер ARVEXA отклонил проверку.',
	'The ARVEXA server is unavailable.': 'Сервер ARVEXA недоступен.',
	'Too many reports — try again in a few minutes.': 'Слишком много отчётов — попробуйте через несколько минут.',
	'The ARVEXA server refused the report.': 'Сервер ARVEXA не принял отчёт.',
	'answers · %1$s': 'отвечает · %1$s',
	'Certificate problem: %1$s': 'Проблема с сертификатом: %1$s',
	'Certificate expires in %1$s days': 'Сертификат истекает через %1$s дн.',
	'DNS': 'DNS',
	'connection': 'соединение',
	'TLS handshake': 'TLS-рукопожатие',
	'HTTP response': 'HTTP-ответ',
	'no answer in 8 s': 'нет ответа за 8 с',
	'domain does not exist': 'домен не существует',
	'DNS error': 'ошибка DNS',
	'connection refused': 'соединение отклонено',
	'connection dropped': 'соединение оборвано',
	'TLS error': 'ошибка TLS',
	'invalid HTTP response': 'некорректный HTTP-ответ',
	'private address, not checked': 'внутренний адрес, не проверяется',
	'page HTML': 'HTML страницы',
	'inline code on the page': 'встроенный код страницы',
	'Added by: %1$s': 'Подключил: %1$s',
	'Call chain: %1$s': 'Цепочка вызовов: %1$s',
	'This server does not answer. While the request hangs, the browser treats the page as still loading. Remove this code or ask whoever installed it to load it asynchronously after the page has loaded.': 'Сервер не отвечает. Пока запрос висит, браузер считает страницу недогруженной. Уберите этот код или попросите того, кто его ставил, подключать его асинхронно после загрузки страницы.',
	'The request failed. If the service is no longer used, remove its code from the site.': 'Запрос завершился ошибкой. Если сервис больше не нужен, уберите его код с сайта.',
	'This script is loaded synchronously in <head>: the page is not painted until it downloads. Add async or defer, or move it to the end of <body>.': 'Скрипт подключён синхронно в <head>: страница не рисуется, пока он не скачается. Добавьте async или defer либо перенесите его в конец <body>.',

	// Service directory (third-party-core.js SERVICES)
	'Yandex Metrica': 'Яндекс Метрика',
	'Yandex SmartCaptcha': 'Яндекс SmartCaptcha',
	'analytics': 'аналитика',
	'review widget': 'виджет отзывов',
	'ticket sales': 'продажа билетов',
	'click-fraud protection, tag manager': 'защита от скликивания, менеджер тегов',
	'call tracking': 'коллтрекинг',
	'site builder': 'конструктор сайта',
	'social widgets, pixel': 'соцвиджеты, пиксель',
	'tag manager': 'менеджер тегов',
	'fonts': 'шрифты',
	'public CDN': 'публичный CDN',
	'online chat': 'онлайн-чат',
	'anti-bot protection': 'защита от ботов',
	'captcha': 'капча'
};
```

- [ ] **Step 3: `standalone/src/standalone.css`**

```css
/* ARVEXA Perf standalone additions (third-party section). */

#arvexa-performance-overlay-root .po-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin: 4px 0 6px;
}

#arvexa-performance-overlay-root .po-btn {
	padding: 4px 9px;
	border: 1px solid rgba(255, 255, 255, 0.16);
	border-radius: 7px;
	background: rgba(255, 255, 255, 0.06);
	color: #e8eaef;
	font: inherit;
	cursor: pointer;
}

#arvexa-performance-overlay-root .po-btn:hover:not([disabled]) {
	background: rgba(255, 255, 255, 0.12);
}

#arvexa-performance-overlay-root .po-btn[disabled] {
	opacity: 0.55;
	cursor: default;
}

#arvexa-performance-overlay-root .po-share-link {
	color: #7cc4ff;
	word-break: break-all;
}
```

- [ ] **Step 4: `tools/build-standalone.mjs`**

```js
#!/usr/bin/env node
// Builds the standalone ARVEXA Perf bundle (overlay core + third-party section)
// and optionally copies it into the client portal (arvexa-back).
// Usage: node tools/build-standalone.mjs [--api https://portal.arvexa.ru] [--portal G:/1212/arvexa-back | none]
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(name);
	return i === -1 ? def : args[i + 1];
};
const api = opt('--api', 'https://portal.arvexa.ru').replace(/\/$/, '');
const portal = opt('--portal', 'G:/1212/arvexa-back');
const LOADER_VERSION = 1;

const read = (p) => readFileSync(join(root, p), 'utf8');
const version = /Version:\s*([0-9.]+)/.exec(read('arvexa-performance-overlay.php'))[1];

function minify(code, loader) {
	return execFileSync('npx', ['--yes', 'esbuild@0.25.0', `--loader=${loader}`, '--minify', '--target=es2017'], {
		input: code,
		encoding: 'utf8',
		shell: process.platform === 'win32',
	});
}

const js = [
	read('standalone/src/i18n-ru.js'),
	read('standalone/src/prelude.js').replaceAll('__ARVEXA_API__', api).replaceAll('__ARVEXA_VERSION__', version),
	read('assets/arvexa-performance-overlay.js'),
	read('standalone/src/third-party-core.js'),
	read('standalone/src/third-party-section.js'),
].join('\n;\n');
const css = read('assets/arvexa-performance-overlay.css') + '\n' + read('standalone/src/standalone.css');

const jsMin = minify(js, 'js');
const cssMin = minify(css, 'css');
const hash = createHash('sha256').update(jsMin).update(cssMin).digest('hex').slice(0, 10);

const out = join(root, 'standalone/dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'static'), { recursive: true });
writeFileSync(join(out, `static/overlay.${hash}.js`), jsMin);
writeFileSync(join(out, `static/overlay.${hash}.css`), cssMin);

// Short-cache pointer: the snippet always loads /perf/overlay.js, which pulls the hashed files.
const base = JSON.stringify(api + '/perf/static/');
const pointer =
	`(function(){var b=${base},d=document,h=d.head||d.documentElement,l=d.createElement('link');` +
	`l.rel='stylesheet';l.href=b+'overlay.${hash}.css';h.appendChild(l);` +
	`var s=d.createElement('script');s.async=true;s.src=b+'overlay.${hash}.js';h.appendChild(s);})();\n`;
writeFileSync(join(out, 'overlay.js'), pointer);

const loaderMin = minify(read('standalone/src/loader.js').replaceAll('__ARVEXA_API__', api), 'js').trim();
const snippet = `<!-- ARVEXA Perf v${LOADER_VERSION} --><script>${loaderMin}</script>`;
writeFileSync(join(out, 'snippet.html'), snippet + '\n');

console.log(`bundle   overlay.${hash}.js  ${jsMin.length} B`);
console.log(`styles   overlay.${hash}.css ${cssMin.length} B`);
console.log(`snippet  ${snippet.length} B`);
if (snippet.length > 3000) {
	console.error('snippet is larger than 3000 bytes — keep the loader minimal');
	process.exit(1);
}

if (portal !== 'none') {
	if (!existsSync(join(portal, 'package.json'))) {
		console.error(`portal not found at ${portal} (pass --portal none to skip)`);
		process.exit(1);
	}
	const pub = join(portal, 'public/perf');
	mkdirSync(join(pub, 'static'), { recursive: true });
	// Old hashed files stay: browsers may hold a cached pointer for up to 5 minutes.
	for (const f of readdirSync(join(out, 'static'))) {
		copyFileSync(join(out, 'static', f), join(pub, 'static', f));
	}
	copyFileSync(join(out, 'overlay.js'), join(pub, 'overlay.js'));
	mkdirSync(join(portal, 'src/lib/perf'), { recursive: true });
	writeFileSync(
		join(portal, 'src/lib/perf/snippet.generated.ts'),
		'// Generated by arvexa-performance-overlay/tools/build-standalone.mjs — do not edit.\n' +
			`export const PERF_SNIPPET = ${JSON.stringify(snippet)};\n` +
			`export const PERF_LOADER_VERSION = ${LOADER_VERSION};\n` +
			`export const PERF_OVERLAY_VERSION = ${JSON.stringify(version)};\n`,
	);
	console.log(`copied to ${portal}`);
}
```

- [ ] **Step 5: Harness server `standalone/harness/serve.mjs`**

```js
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
```

- [ ] **Step 6: Harness page `standalone/harness/index.html`**

```html
<!doctype html>
<html lang="ru">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<!--SNIPPET-->
	<title>ARVEXA Perf harness</title>
	<script src="http://127.0.0.3:4000/slow.js"></script>
</head>
<body style="font-family: sans-serif; padding: 24px;">
	<h1>Тестовая страница</h1>
	<p>Ожидается: «Не отвечают» — 127.0.0.2, подключил 127.0.0.3; «Блокируют отрисовку» — slow.js; через 10 с — «держат загрузку».</p>
	<script>
		setTimeout(function () {
			var s = document.createElement('script');
			s.src = 'http://127.0.0.3:4000/vendor.js';
			document.head.appendChild(s);
		}, 200);
	</script>
</body>
</html>
```

- [ ] **Step 7: Ignore build output**

Append to `.gitignore`:

```
standalone/dist/
```

- [ ] **Step 8: Build without the section yet and smoke-test the core**

Create an empty placeholder so the build can run before Task 5: `standalone/src/third-party-section.js` containing only `/* filled in Task 5 */`.

Run: `node tools/build-standalone.mjs --api http://127.0.0.1:4000 --portal none`
Expected: three lines (`bundle`, `styles`, `snippet` < 3000 B), exit 0.

Run (background): `node standalone/harness/serve.mjs`
Open `http://localhost:4000/?arvexa=1` in Chrome. Expected: the panel is open on first visit, section titles in Russian («Сеть», «Отрисовка»), no «No server data» line. DevTools console: `__arvexaPerf.q` contains records for `slow.js` (source `html`, `async: false`, `head: true`), `vendor.js` (source `script`) and `https://127.0.0.2:9443/tags/x/sdk.js` (source `script`, `state: 'loading'`, `stack` mentions `127.0.0.3:4000/vendor.js`). Open `http://localhost:4000/?arvexa=0`: no panel, `window.__arvexaPerf` is `undefined`.

- [ ] **Step 9: Commit**

```bash
git add standalone/src/prelude.js standalone/src/i18n-ru.js standalone/src/standalone.css standalone/src/third-party-section.js tools/build-standalone.mjs standalone/harness .gitignore
git commit -m "feat(standalone): build tool, Russian dictionary, local harness"
```

---

### Task 5: "Third-party requests" section

**Files:**
- Modify (replace placeholder): `standalone/src/third-party-section.js`
- Test: `standalone/test/i18n-ru.test.js`

**Interfaces:**
- Consumes: `window.ArvexaPerformanceOverlay` (`registerSection`, `helpers.{row, expRow, section, esc, ms, secs, bytes, grade}`, `vitals`, `refresh`), `window.ArvexaThirdPartyCore` (Task 1), `window.ArvexaPerformanceOverlayConfig` (Task 4), `window.__arvexaPerf` (Task 3), API contracts above.
- Produces: section id `third-party`, order `-10`.

- [ ] **Step 1: Write the failing dictionary test**

Create `standalone/test/i18n-ru.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = {};
require('../src/i18n-ru.js');
const RU = global.window.__arvexaPerfRu;
const C = require('../src/third-party-core.js');

// Core strings that can appear in the standalone panel (no server data).
const CORE_VISIBLE = [
	'Arvexa Performance Overlay', 'Network', 'TTFB', 'Requests', 'Transferred', 'from cache',
	'Network bytes; cached responses count as 0', 'Rendering', 'LCP', 'LCP element',
	'Largest Contentful Paint element', 'CLS', 'INP', 'Worst interaction so far', 'DOM nodes', 'Long tasks', 'Components'
];

function literals(file) {
	const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
	const out = [];
	const re = /__\('([^']+)'/g;
	let m;
	while ((m = re.exec(src))) {
		out.push(m[1]);
	}
	return out;
}

test('every section string has a Russian translation', () => {
	const strings = literals('standalone/src/third-party-section.js');
	assert.ok(strings.length > 30, 'section strings were found');
	const missing = strings.filter(function (s) { return !Object.prototype.hasOwnProperty.call(RU, s); });
	assert.deepEqual(missing, []);
});

test('core LCP hints and visible core strings are translated', () => {
	const hints = literals('assets/arvexa-performance-overlay.js').filter(function (s) { return /^(LCP |Image is|Long gap|The LCP|Most of LCP)/.test(s); });
	const missing = CORE_VISIBLE.concat(hints).filter(function (s) { return !Object.prototype.hasOwnProperty.call(RU, s); });
	assert.deepEqual(missing, []);
});

test('service names and kinds are translated or proper nouns', () => {
	const proper = /^[A-Za-z][A-Za-z@.]*( [A-Z][A-Za-z]+)*$/; // Latin proper names: GetReview, jsDelivr, Google Tag Manager…
	const missing = [];
	C.SERVICES.forEach(function (s) {
		if (!RU[s.kind]) { missing.push(s.kind); }
		if (!RU[s.name] && !proper.test(s.name)) { missing.push(s.name); }
	});
	assert.deepEqual(missing, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test standalone/test/`
Expected: FAIL in "every section string has a Russian translation" (`section strings were found` — the placeholder has none).

- [ ] **Step 3: Implement `standalone/src/third-party-section.js`**

```js
/**
 * ARVEXA Perf — "Third-party requests" section for the standalone overlay.
 *
 * Reads the inline loader's buffer (window.__arvexaPerf), classifies it with
 * ArvexaThirdPartyCore and renders through the core's registerSection API.
 * Also drives the two server actions: domain probe and shareable report.
 */
(function () {
	'use strict';

	var O = window.ArvexaPerformanceOverlay;
	var C = window.ArvexaThirdPartyCore;
	if (!O || !C) {
		return;
	}
	var cfg = window.ArvexaPerformanceOverlayConfig || {};
	var H = O.helpers;
	var i18n = cfg.i18n || {};
	var __ = i18n.__ || function (text) { return text; };
	var sprintf = i18n.sprintf || function (fmt) {
		var args = arguments;
		return String(fmt).replace(/%([1-9])\$s/g, function (_, n) { return args[+n]; });
	};

	var st = window.__arvexaPerf || null;
	var API = cfg.api || (st && st.api) || '';
	var SELF = [C.hostOf(API)];
	var pageHost = location.hostname.toLowerCase();

	var probe = { state: 'idle', results: null, error: '' };
	var share = { state: 'idle', url: '', error: '' };

	// Long Animation Frames carry per-script attribution (Chromium 123+).
	var frames = [];
	var loafSupported = typeof PerformanceObserver !== 'undefined' &&
		(PerformanceObserver.supportedEntryTypes || []).indexOf('long-animation-frame') !== -1;
	if (loafSupported) {
		try {
			new PerformanceObserver(function (list) {
				frames = frames.concat(list.getEntries()).slice(-400);
				O.refresh();
			}).observe({ type: 'long-animation-frame', buffered: true });
		} catch (e) { /* unsupported after all */ }
	}

	function snapshotState() {
		var entries = performance.getEntriesByType ? performance.getEntriesByType('resource') : [];
		var views = C.classify(st ? st.q : [], entries, performance.now(), { selfHosts: SELF, pageUrl: location.href });
		var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
		return {
			views: views,
			hosts: C.groupByHost(entries, views, { selfHosts: SELF, pageHost: pageHost }),
			cpu: C.cpuByHost(frames, { selfHosts: SELF }),
			nav: nav,
			hold: C.loadHold(document.readyState, performance.now(), views)
		};
	}

	function serviceLabel(host) {
		var s = C.lookupService(host);
		return s ? __(s.name) + ' · ' + __(s.kind) : host;
	}

	function initiatorText(v) {
		if (v.initiator === 'html') {
			return __('page HTML');
		}
		if (v.initiator === 'inline') {
			return __('inline code on the page');
		}
		var h = C.hostOf(v.initiator);
		var s = C.lookupService(h);
		return s ? __(s.name) + ' (' + h + ')' : h;
	}

	function hintFor(v) {
		if (v.state === 'pending') {
			return __('This server does not answer. While the request hangs, the browser treats the page as still loading. Remove this code or ask whoever installed it to load it asynchronously after the page has loaded.');
		}
		if (v.state === 'error') {
			return __('The request failed. If the service is no longer used, remove its code from the site.');
		}
		if (v.blocking) {
			return __('This script is loaded synchronously in <head>: the page is not painted until it downloads. Add async or defer, or move it to the end of <body>.');
		}
		return '';
	}

	function requestDetail(v) {
		var d = '<div>' + H.esc(v.url) + '</div>' +
			'<div>' + H.esc(sprintf(__('Added by: %1$s'), initiatorText(v))) + '</div>';
		if (v.chain.length > 1) {
			d += '<div>' + H.esc(sprintf(__('Call chain: %1$s'), v.chain.join(' → '))) + '</div>';
		}
		var hint = hintFor(v);
		if (hint) {
			d += '<div class="po-hint po-hint-' + (v.state === 'done' ? 'warn' : 'poor') + '">' + H.esc(hint) + '</div>';
		}
		return d;
	}

	function uniqueHosts(views) {
		var out = [];
		views.forEach(function (v) {
			if (out.indexOf(v.host) === -1) {
				out.push(v.host);
			}
		});
		return out;
	}

	function warnHint(text) {
		return '<div class="po-hint po-hint-warn">' + H.esc(text) + '</div>';
	}

	function render() {
		var s = snapshotState();
		var html = '';

		if (!st) {
			html += warnHint(__('The ARVEXA Perf snippet was not found in <head> — hanging requests and their initiators are unavailable. Paste the snippet as the first script in <head>.'));
		} else if (st.v < (cfg.loaderVersion || 1)) {
			html += warnHint(__('The snippet on this site is outdated — copy the new one from portal.arvexa.ru/perf.'));
		}

		// --- Page load ---
		var nav = s.nav;
		var dcl = nav && nav.domContentLoadedEventEnd ? nav.domContentLoadedEventEnd : null;
		var load = nav && nav.loadEventEnd ? nav.loadEventEnd : null;
		var loadRows =
			H.row(__('DOM ready'), H.ms(dcl), H.grade(dcl, 2000, 4000)) +
			H.row(__('Fully loaded'), load ? H.ms(load) : H.esc(__('not yet')), load ? H.grade(load, 4000, 8000) : s.hold ? 'poor' : '');
		if (s.hold) {
			var holders = uniqueHosts(s.hold.pending).slice(0, 4).map(serviceLabel).join(', ');
			loadRows += '<div class="po-hint po-hint-poor">' +
				H.esc(sprintf(__('The page has been loading for %1$s. Holding it: %2$s'), H.secs(s.hold.sinceMs / 1000), holders || __('unknown requests'))) +
				'</div>';
		}
		html += H.section(__('Page load'), loadRows);

		// --- Hanging / failed ---
		var bad = s.views.filter(function (v) { return v.state === 'pending' || v.state === 'error'; });
		if (bad.length) {
			html += H.section(__('Not responding'), bad.map(function (v) {
				var value = v.state === 'pending' ? sprintf(__('hangs %1$s'), H.secs(v.ageMs / 1000)) : __('failed');
				return H.expRow('tp-bad:' + v.url, H.esc(serviceLabel(v.host)), H.esc(value), 'poor', requestDetail(v));
			}).join(''));
		}

		// --- Render-blocking ---
		var blocking = s.views.filter(function (v) { return v.blocking && v.state !== 'pending'; });
		if (blocking.length) {
			html += H.section(__('Block rendering'), blocking.map(function (v) {
				return H.expRow('tp-block:' + v.url, H.esc(serviceLabel(v.host)), H.esc(H.ms(v.durationMs)), 'warn', requestDetail(v));
			}).join(''));
		}

		// --- Domains ---
		if (s.hosts.length) {
			html += H.section(__('Domains'), s.hosts.slice(0, 12).map(function (g) {
				var parts = [g.count + ' ' + __('req')];
				if (g.transfer) {
					parts.push(H.bytes(g.transfer));
				}
				parts.push(H.ms(g.slowestMs));
				var gradeClass = g.pending ? 'poor' : H.grade(g.slowestMs, 1000, 3000);
				var label = g.host === pageHost
					? '<i class="po-badge po-badge-core">' + H.esc(__('site')) + '</i>' + H.esc(g.host)
					: H.esc(serviceLabel(g.host));
				return '<div class="po-row" title="' + H.esc(g.host) + '">' +
					'<span class="po-label">' + label + '</span>' +
					'<span class="po-value ' + gradeClass + '">' + H.esc(parts.join(' · ')) + '</span>' +
					'</div>';
			}).join(''));
		}

		// --- CPU ---
		if (s.cpu.length) {
			html += H.section(__('CPU load by script'), s.cpu.slice(0, 8).map(function (c) {
				var label = c.host === pageHost || c.host === 'inline' ? __('this site (inline code)') : serviceLabel(c.host);
				return H.row(label, H.ms(c.ms), H.grade(c.ms, 200, 600), __('Main-thread time in long animation frames'));
			}).join(''));
		} else if (!loafSupported) {
			html += warnHint(__('This browser does not report which scripts load the CPU — open the page in Chrome or Edge.'));
		}

		html += H.section(__('Check'), actionsHtml());
		return html;
	}

	function totalMs(t) {
		return (t.dns || 0) + (t.tcp || 0) + (t.tls || 0) + (t.ttfb || 0);
	}

	function stageLabel(stage) {
		var map = { dns: __('DNS'), tcp: __('connection'), tls: __('TLS handshake'), http: __('HTTP response') };
		return map[stage] || stage;
	}

	function errorLabel(code) {
		var map = {
			TIMEOUT: __('no answer in 8 s'),
			NXDOMAIN: __('domain does not exist'),
			DNS: __('DNS error'),
			REFUSED: __('connection refused'),
			RESET: __('connection dropped'),
			TLS: __('TLS error'),
			HTTP: __('invalid HTTP response'),
			PRIVATE: __('private address, not checked')
		};
		return map[code] || String(code);
	}

	function probeRow(r) {
		var text;
		var gradeClass;
		var title = '';
		if (r.cert && !r.cert.authorized) {
			title = sprintf(__('Certificate problem: %1$s'), r.cert.error);
		} else if (r.cert && r.cert.daysLeft !== null && r.cert.daysLeft < 14) {
			title = sprintf(__('Certificate expires in %1$s days'), r.cert.daysLeft);
		}
		if (r.ok) {
			text = sprintf(__('answers · %1$s'), H.ms(totalMs(r.timings)));
			gradeClass = title ? 'warn' : H.grade(totalMs(r.timings), 1000, 3000);
		} else {
			text = stageLabel(r.stage) + ': ' + errorLabel(r.error);
			gradeClass = 'poor';
		}
		return H.row(serviceLabel(r.host), H.esc(text), gradeClass, title);
	}

	function actionsHtml() {
		var out = '<div class="po-actions">' +
			'<button type="button" class="po-btn" data-arvexa-act="probe"' + (probe.state === 'running' ? ' disabled' : '') + '>' +
			H.esc(probe.state === 'running' ? __('Checking…') : __('Check from ARVEXA server')) + '</button>' +
			'<button type="button" class="po-btn" data-arvexa-act="share"' + (share.state === 'running' ? ' disabled' : '') + '>' +
			H.esc(share.state === 'running' ? __('Saving…') : __('Share report')) + '</button>' +
			'</div>';
		if (probe.state === 'error') {
			out += '<div class="po-hint po-hint-poor">' + H.esc(probe.error) + '</div>';
		}
		if (probe.state === 'done') {
			out += probe.results.map(probeRow).join('');
		}
		if (share.state === 'error') {
			out += '<div class="po-hint po-hint-poor">' + H.esc(share.error) + '</div>';
		}
		if (share.state === 'done') {
			out += '<div class="po-hint">' + H.esc(__('Report link (valid 30 days):')) +
				' <a class="po-share-link" href="' + H.esc(share.url) + '" target="_blank" rel="noopener noreferrer">' + H.esc(share.url) + '</a></div>';
		}
		return out;
	}

	function post(path, body) {
		return fetch(API + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			credentials: 'omit'
		}).then(function (r) {
			return r.json().catch(function () { return {}; }).then(function (j) {
				return { status: r.status, body: j };
			});
		});
	}

	function probeHosts() {
		var s = snapshotState();
		var list = [];
		function add(h) {
			if (h && h !== pageHost && SELF.indexOf(h) === -1 && h.indexOf('.') !== -1 &&
				!/^[\d.]+$/.test(h) && list.indexOf(h) === -1) {
				list.push(h);
			}
		}
		s.views.forEach(function (v) {
			if (v.state === 'pending' || v.state === 'error') {
				add(v.host);
			}
		});
		s.hosts.forEach(function (g) { add(g.host); });
		return list.slice(0, 30);
	}

	function runProbe() {
		if (probe.state === 'running') {
			return;
		}
		var hosts = probeHosts();
		if (!hosts.length) {
			probe = { state: 'error', results: null, error: __('No third-party domains to check.') };
			O.refresh();
			return;
		}
		probe = { state: 'running', results: null, error: '' };
		O.refresh();
		post('/api/perf/probe', { origin: location.origin, hosts: hosts }).then(function (res) {
			probe = res.status === 200 && res.body.results
				? { state: 'done', results: res.body.results, error: '' }
				: { state: 'error', results: null, error: res.status === 429 ? __('Too many checks — try again in a few minutes.') : __('The ARVEXA server refused the check.') };
			O.refresh();
		}, function () {
			probe = { state: 'error', results: null, error: __('The ARVEXA server is unavailable.') };
			O.refresh();
		});
	}

	function runShare() {
		if (share.state === 'running') {
			return;
		}
		var s = snapshotState();
		var nav = s.nav;
		var snap = C.buildSnapshot({
			loaderVersion: st ? st.v : 0,
			overlayVersion: cfg.version,
			pageUrl: location.href,
			ua: navigator.userAgent,
			capturedAt: new Date().toISOString(),
			vitals: O.vitals,
			dcl: nav && nav.domContentLoadedEventEnd ? nav.domContentLoadedEventEnd : null,
			load: nav && nav.loadEventEnd ? nav.loadEventEnd : null,
			views: s.views,
			hosts: s.hosts,
			cpu: s.cpu,
			probe: probe.state === 'done' ? probe.results : null
		});
		share = { state: 'running', url: '', error: '' };
		O.refresh();
		post('/api/perf/reports', snap).then(function (res) {
			share = res.status === 201 && res.body.url
				? { state: 'done', url: res.body.url, error: '' }
				: { state: 'error', url: '', error: res.status === 429 ? __('Too many reports — try again in a few minutes.') : __('The ARVEXA server refused the report.') };
			O.refresh();
		}, function () {
			share = { state: 'error', url: '', error: __('The ARVEXA server is unavailable.') };
			O.refresh();
		});
	}

	document.addEventListener('click', function (e) {
		var btn = e.target && e.target.closest ? e.target.closest('[data-arvexa-act]') : null;
		if (!btn || !btn.closest('#arvexa-performance-overlay-root')) {
			return;
		}
		var act = btn.getAttribute('data-arvexa-act');
		if (act === 'probe') {
			runProbe();
		} else if (act === 'share') {
			runShare();
		}
	});

	// Hanging timers ("hangs 34 s") need a live clock until everything settles.
	var started = Date.now();
	var ticker = setInterval(function () {
		O.refresh();
		var busy = document.readyState !== 'complete' || snapshotState().views.some(function (v) {
			return v.state === 'pending' || v.state === 'loading';
		});
		if (!busy || Date.now() - started > 120000) {
			clearInterval(ticker);
		}
	}, 1000);

	O.registerSection('third-party', render, -10);
})();
```

- [ ] **Step 4: Run tests**

Run: `node --test standalone/test/`
Expected: all PASS. If "every section string…" lists missing keys, add them to `i18n-ru.js` (Russian) and re-run.

- [ ] **Step 5: Harness end-to-end check**

Run: `node tools/build-standalone.mjs --api http://127.0.0.1:4000 --portal none`, then (background) `node standalone/harness/serve.mjs`, open `http://localhost:4000/?arvexa=1` in Chrome and wait 12 s. Expected in the panel, top section first:
- «Загрузка страницы»: «Полностью загружена — ещё нет» (red) and the hint «Страница грузится уже 1x s. Держат загрузку: 127.0.0.2».
- «Не отвечают»: `127.0.0.2` — «висит N s», counter grows every second; expanding shows «Подключил: 127.0.0.3» and «Цепочка вызовов» is absent or `127.0.0.3`.
- «Блокируют отрисовку»: `127.0.0.3` (~1.5 s, slow.js).
- «Нагрузка на процессор»: `127.0.0.3` ≈ 300 ms.
- «Проверить с сервера ARVEXA» → «Сервер ARVEXA недоступен.» (the harness has no API) — page keeps working.
Stop the harness.

- [ ] **Step 6: Commit**

```bash
git add standalone/src/third-party-section.js standalone/src/i18n-ru.js standalone/test/i18n-ru.test.js
git commit -m "feat(standalone): third-party requests section with probe and share"
```

---

### Task 6: wp.org packaging guard, WP regression, real-site check

**Files:**
- Create: `.distignore`, `.gitattributes`

- [ ] **Step 1: Packaging guard**

`.distignore`:

```
/.git
/.gitignore
/.gitattributes
/.distignore
/.wordpress-org
/docs
/tools
/standalone
/README.md
```

`.gitattributes`:

```
/docs export-ignore
/tools export-ignore
/standalone export-ignore
/.distignore export-ignore
/.gitattributes export-ignore
```

Check: `git archive --format=tar HEAD | tar -t | grep -E "^(docs|tools|standalone)/"` → after committing, expected: no output.

- [ ] **Step 2: WP regression on the local stand**

Copy (do **not** junction — see memory "Junction upgrader data loss") `assets/arvexa-performance-overlay.js` into the plugin copy on `C:\wp-local`, open a front-end page as admin. Expected: panel identical to before (server sections, «No server data» only where it was before, AJAX/REST section works, admin-bar toggle works), no console errors.

- [ ] **Step 3: Real sites without installing**

Build for production: `node tools/build-standalone.mjs --portal none`. In Chrome DevTools → Sources → Overrides, override `https://minmagic.ru/oferta` and insert the content of `standalone/dist/snippet.html` right after `<head>`; with `--api` pointing at the harness host (`node tools/build-standalone.mjs --api http://127.0.0.1:4000 --portal none` + harness running) the overlay loads locally. Open `https://minmagic.ru/oferta?arvexa=1` (if Chrome asks to allow access to the local network for the site, allow it — the overlay is served from 127.0.0.1). Expected (from the manual diagnosis on 2026-10-15): `app.getreview.io` in «Не отвечают» with an initiator (if it is `stat1.clickfraud.ru` — record it; this answers the open question), `s3.intickets.ru` in «Блокируют отрисовку», Yandex Metrica / Clickfraud in «Нагрузка на процессор» if their frames exceed 50 ms. Repeat for `https://wizardia.land/` (getreview from page HTML → «Подключил: HTML страницы»). Note any false «Не отвечают» rows and fix their cause before Task 7 of plan B.

- [ ] **Step 4: Commit**

```bash
git add .distignore .gitattributes
git commit -m "chore: keep standalone build, tools and docs out of wp.org packages"
```

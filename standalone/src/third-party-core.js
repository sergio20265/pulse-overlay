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
		{ match: ['mango-office.ru', 'mng.tl'], name: 'Mango Office', kind: 'call tracking' },
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

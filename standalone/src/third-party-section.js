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

	// Browsers eventually abort a hanging request (Chrome: ERR_TIMED_OUT) and fire
	// "error" — that is still a non-answering server, not an ordinary failure.
	function timedOut(v) {
		return v.state === 'error' && v.durationMs !== null && v.durationMs >= C.PENDING_MS;
	}

	function hintFor(v) {
		if (v.state === 'pending' || timedOut(v)) {
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
				var value = v.state === 'pending'
					? sprintf(__('hangs %1$s'), H.secs(v.ageMs / 1000))
					: timedOut(v) ? sprintf(__('no answer for %1$s'), H.secs(v.durationMs / 1000)) : __('failed');
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
				// A host whose only request hangs has no Resource Timing entries yet.
				var parts = g.count ? [g.count + ' ' + __('req')] : [];
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

/**
 * Pulse — Live Performance Overlay.
 *
 * Reads the server-side JSON blob printed by Pulse_Collector, collects
 * browser-side metrics (Web Vitals, DOM size, network cost) and renders
 * a floating panel. Everything is wrapped so a failure here can never
 * break the host page.
 */
(function () {
	'use strict';

	var LS_KEY = 'pulseOverlayOpen';
	var COOKIE = 'pulse_overlay_on';

	// wp-i18n is declared as a script dependency, but guard anyway — this
	// file must never break the host page even if load order is disturbed.
	var i18n = (window.wp && window.wp.i18n) || {};
	var __ = i18n.__ || function (text) { return text; };
	var sprintf = i18n.sprintf || function (fmt) {
		var args = arguments;
		var i = 1;
		return fmt.replace(/%[12]\$s/g, function () { return args[i++]; });
	};

	// Read lazily: the JSON blob is printed AFTER this script tag in the
	// footer, so it must not be read at evaluation time.
	var server = null;

	var vitals = {
		lcp: null,
		lcpEl: null,
		cls: 0,
		shifts: {},
		inp: null,
		ttfb: null,
		longTasks: 0
	};

	// Short human-readable element descriptor: "img#hero" / "div.gallery".
	function describeEl(el) {
		try {
			if (!el || !el.tagName) {
				return '';
			}
			var s = el.tagName.toLowerCase();
			if (el.id) {
				return s + '#' + el.id;
			}
			if (typeof el.className === 'string' && el.className.trim()) {
				s += '.' + el.className.trim().split(/\s+/)[0];
			}
			return s;
		} catch (e) {
			return '';
		}
	}

	var root, pill, panel;

	// ---------------------------------------------------------------------
	// Data
	// ---------------------------------------------------------------------

	function readServerData() {
		try {
			var el = document.getElementById('pulse-overlay-data');
			if (el) {
				var parsed = JSON.parse(el.textContent);
				if (parsed && typeof parsed === 'object') {
					return parsed;
				}
			}
			// Fallback for HTML minifiers that strip type="application/json"
			// blocks: the collector also assigns a plain window global.
			if (window.__pulseData && typeof window.__pulseData === 'object') {
				return window.__pulseData;
			}
		} catch (e) {
			/* fall through */
		}
		return null;
	}

	// Optimizers may defer or reorder inline scripts, so if the blob is not
	// there yet, poll briefly before giving up.
	function watchServerData() {
		if (server) {
			return;
		}
		var attempts = 0;
		var timer = setInterval(function () {
			server = readServerData();
			if (server || ++attempts >= 20) {
				clearInterval(timer);
				if (server) {
					scheduleRender();
				}
			}
		}, 250);
	}

	function observe(type, options, cb) {
		if (typeof PerformanceObserver === 'undefined') {
			return;
		}
		try {
			var po = new PerformanceObserver(function (list) {
				cb(list.getEntries());
			});
			po.observe(Object.assign({ type: type, buffered: true }, options || {}));
		} catch (e) {
			/* entry type not supported — fine */
		}
	}

	function collectVitals() {
		observe('largest-contentful-paint', null, function (entries) {
			var last = entries[entries.length - 1];
			if (last) {
				vitals.lcp = last.startTime;
				vitals.lcpEl = describeEl(last.element) || vitals.lcpEl;
				scheduleRender();
			}
		});

		observe('layout-shift', null, function (entries) {
			entries.forEach(function (e) {
				if (e.hadRecentInput) {
					return;
				}
				vitals.cls += e.value;
				// Attribute the shift value to the elements that moved.
				if (e.sources) {
					e.sources.forEach(function (s) {
						var key = describeEl(s.node);
						if (key) {
							vitals.shifts[key] = (vitals.shifts[key] || 0) + e.value;
						}
					});
				}
			});
			scheduleRender();
		});

		// INP approximation: worst interaction duration seen so far.
		observe('event', { durationThreshold: 40 }, function (entries) {
			entries.forEach(function (e) {
				if (e.interactionId && (vitals.inp === null || e.duration > vitals.inp)) {
					vitals.inp = e.duration;
				}
			});
			scheduleRender();
		});

		observe('longtask', null, function (entries) {
			vitals.longTasks += entries.length;
			scheduleRender();
		});

		var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
		if (nav) {
			vitals.ttfb = nav.responseStart;
		}
	}

	function collectResources() {
		var out = {
			count: 0,
			transfer: 0,
			byComponent: {}
		};
		if (!performance.getEntriesByType) {
			return out;
		}
		var entries = performance.getEntriesByType('resource');
		out.count = entries.length;

		entries.forEach(function (e) {
			// transferSize is 0 for cache hits and opaque cross-origin
			// responses; fall back to the resource size for a usable weight.
			var size = e.transferSize || e.encodedBodySize || 0;
			out.transfer += e.transferSize || 0;
			var m = e.name.match(/\/wp-content\/(plugins|mu-plugins|themes)\/([^\/]+)\//);
			if (!m) {
				return;
			}
			var key =
				(m[1] === 'plugins' ? 'plugin:' : m[1] === 'themes' ? 'theme:' : 'mu-plugin:') + m[2];
			if (key === 'plugin:pulse-overlay' || key === 'plugin:pulse-pro') {
				return;
			}
			if (!out.byComponent[key]) {
				out.byComponent[key] = { count: 0, transfer: 0 };
			}
			out.byComponent[key].count++;
			out.byComponent[key].transfer += size;
		});

		return out;
	}

	function domNodeCount() {
		return document.getElementsByTagName('*').length;
	}

	// ---------------------------------------------------------------------
	// AJAX / REST spy: patch fetch + XHR, read the X-Pulse server header
	// ---------------------------------------------------------------------

	var netCalls = [];

	function bodyToString(b) {
		try {
			if (!b) {
				return '';
			}
			if (typeof b === 'string') {
				return b;
			}
			if (window.URLSearchParams && b instanceof URLSearchParams) {
				return b.toString();
			}
			if (window.FormData && b instanceof FormData && b.get) {
				return 'action=' + (b.get('action') || '');
			}
		} catch (e) { /* opaque body */ }
		return '';
	}

	function requestName(url, bodyStr) {
		var a = document.createElement('a');
		a.href = url;
		if (a.host && a.host !== location.host) {
			return null;
		}
		var path = a.pathname;
		var qs = a.search || '';

		if (path.indexOf('admin-ajax.php') !== -1) {
			var m = /[?&]action=([^&]+)/.exec(qs) || /(?:^|&)action=([^&]+)/.exec(bodyStr || '');
			var name = m ? decodeURIComponent(m[1]) : 'admin-ajax';
			if (name === 'pulse_overlay_sample') {
				return null; // our own beacon
			}
			return { kind: 'ajax', name: name };
		}
		var wc = /[?&]wc-ajax=([^&]+)/.exec(qs);
		if (wc) {
			return { kind: 'ajax', name: 'wc: ' + decodeURIComponent(wc[1]) };
		}
		var i = path.indexOf('/wp-json/');
		if (i !== -1) {
			return { kind: 'rest', name: path.slice(i + 9) };
		}
		return null;
	}

	function parsePulseHeader(raw) {
		try {
			return raw ? JSON.parse(raw) : null;
		} catch (e) {
			return null;
		}
	}

	function finishCall(info, started, status, srv) {
		netCalls.unshift({
			kind: info.kind,
			name: info.name,
			dur: performance.now() - started,
			status: status,
			srv: srv
		});
		if (netCalls.length > 12) {
			netCalls.length = 12;
		}
		scheduleRender();
	}

	function initNetSpy() {
		var origFetch = window.fetch;
		if (origFetch) {
			window.fetch = function (input, init) {
				var promise = origFetch.apply(this, arguments);
				try {
					var url = typeof input === 'string' ? input : (input && input.url) || '';
					var info = requestName(url, bodyToString(init && init.body));
					if (info) {
						var started = performance.now();
						promise.then(
							function (resp) {
								finishCall(info, started, resp.status, parsePulseHeader(resp.headers.get('X-Pulse')));
							},
							function () {
								finishCall(info, started, 0, null);
							}
						);
					}
				} catch (e) { /* never break the caller */ }
				return promise;
			};
		}

		var xhrOpen = XMLHttpRequest.prototype.open;
		var xhrSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.open = function (method, url) {
			this.__pulseUrl = url;
			return xhrOpen.apply(this, arguments);
		};
		XMLHttpRequest.prototype.send = function (body) {
			try {
				var info = requestName(this.__pulseUrl || '', bodyToString(body));
				if (info) {
					var xhr = this;
					var started = performance.now();
					xhr.addEventListener('loadend', function () {
						var srv = null;
						try {
							srv = parsePulseHeader(xhr.getResponseHeader('X-Pulse'));
						} catch (e) { /* cross-origin */ }
						finishCall(info, started, xhr.status, srv);
					});
				}
			} catch (e) { /* never break the caller */ }
			return xhrSend.apply(this, arguments);
		};
	}

	// ---------------------------------------------------------------------
	// History: record this page view, compare env groups
	// ---------------------------------------------------------------------

	var sampleSent = false;

	function sendSample() {
		if (sampleSent || !server || !server.history || !navigator.sendBeacon) {
			return;
		}
		sampleSent = true;
		try {
			var res = collectResources();
			var payload = {
				nonce: server.history.nonce,
				url: location.pathname,
				phpTime: server.phpTime,
				sqlCount: server.sql.count,
				sqlTime: server.sql.time,
				memory: server.memory,
				ttfb: vitals.ttfb,
				lcp: vitals.lcp,
				cls: vitals.cls,
				requests: res.count,
				transfer: res.transfer,
				dom: domNodeCount()
			};
			navigator.sendBeacon(
				server.history.ajax + '?action=pulse_overlay_sample',
				new Blob([JSON.stringify(payload)], { type: 'application/json' })
			);
		} catch (e) {
			/* recording is best-effort */
		}
	}

	function armSampling() {
		// Send once the page settles so LCP/CLS are final-ish, or earlier
		// if the user leaves the page.
		window.addEventListener('pagehide', sendSample);
		document.addEventListener('visibilitychange', function () {
			if (document.visibilityState === 'hidden') {
				sendSample();
			}
		});
		window.addEventListener('load', function () {
			setTimeout(sendSample, 8000);
		});
	}

	function median(values) {
		var v = values.filter(function (x) {
			return x !== null && x !== undefined && isFinite(x);
		}).sort(function (a, b) { return a - b; });
		if (!v.length) {
			return null;
		}
		var mid = Math.floor(v.length / 2);
		return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
	}

	function envDiff(prevEnv, curEnv) {
		if (!prevEnv || !curEnv) {
			return null;
		}
		var prev = prevEnv.plugins || [];
		var cur = curEnv.plugins || [];
		var added = cur.filter(function (p) { return prev.indexOf(p) === -1; });
		var removed = prev.filter(function (p) { return cur.indexOf(p) === -1; });
		var parts = added.map(function (p) { return '+ ' + p; })
			.concat(removed.map(function (p) { return '− ' + p; }));
		if (prevEnv.theme !== curEnv.theme) {
			parts.push('theme → ' + curEnv.theme);
		}
		return parts.length ? parts : null;
	}

	function deltaGrade(delta, base) {
		if (delta === null || !base) {
			return '';
		}
		if (delta < 0) {
			return 'good';
		}
		var pct = delta / base;
		return pct > 0.2 ? 'poor' : pct > 0.05 ? 'warn' : '';
	}

	function fmtDelta(delta, fmt) {
		return (delta >= 0 ? '+' : '−') + fmt(Math.abs(delta));
	}

	// Builds the History section HTML, or '' when there is nothing to show.
	function renderHistory() {
		var h = server && server.history;
		if (!h || !h.samples) {
			return '';
		}

		var samples = h.samples.slice();
		// Fold the live page view into the current-env group so a comparison
		// works right after an install, before any new samples are stored.
		samples.push({
			env: h.envHash,
			phpTime: server.phpTime,
			sqlCount: server.sql.count,
			sqlTime: server.sql.time,
			lcp: vitals.lcp,
			transfer: null
		});

		var current = samples.filter(function (s) { return s.env === h.envHash; });
		var prevHash = null;
		for (var i = samples.length - 1; i >= 0; i--) {
			if (samples[i].env !== h.envHash) {
				prevHash = samples[i].env;
				break;
			}
		}

		var html = row(__('Samples', 'pulse-overlay'), String(h.samples.length), '');

		if (!prevHash) {
			return section(__('History', 'pulse-overlay'), html);
		}

		var previous = samples.filter(function (s) { return s.env === prevHash; });
		var diff = envDiff(h.envs && h.envs[prevHash], h.envs && h.envs[h.envHash]);
		if (diff) {
			html += '<div class="po-hint po-env-diff">' + esc(diff.join(', ')) + '</div>';
		}

		var metrics = [
			{ key: 'phpTime', label: __('Δ PHP time', 'pulse-overlay'), fmt: secs },
			{ key: 'sqlCount', label: __('Δ SQL queries', 'pulse-overlay'), fmt: function (v) { return Math.round(v) + ' q'; } },
			{ key: 'sqlTime', label: __('Δ SQL time', 'pulse-overlay'), fmt: secs },
			{ key: 'lcp', label: __('Δ LCP', 'pulse-overlay'), fmt: ms },
			{ key: 'transfer', label: __('Δ Transferred', 'pulse-overlay'), fmt: bytes }
		];

		metrics.forEach(function (m) {
			var was = median(previous.map(function (s) { return s[m.key]; }));
			var now = median(current.map(function (s) { return s[m.key]; }));
			if (was === null || now === null) {
				return;
			}
			var delta = now - was;
			html += row(m.label, fmtDelta(delta, m.fmt), deltaGrade(delta, was), __('median now vs before the change', 'pulse-overlay'));
		});

		return section(__('History · since env change', 'pulse-overlay'), html);
	}

	// ---------------------------------------------------------------------
	// Grading & formatting
	// ---------------------------------------------------------------------

	function grade(value, good, poor) {
		if (value === null || value === undefined) {
			return '';
		}
		if (value <= good) {
			return 'good';
		}
		if (value <= poor) {
			return 'warn';
		}
		return 'poor';
	}

	function ms(v) {
		if (v === null || v === undefined) {
			return '—';
		}
		return v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms';
	}

	function secs(v) {
		if (v === null || v === undefined) {
			return '—';
		}
		return v >= 1 ? v.toFixed(2) + ' s' : Math.round(v * 1000) + ' ms';
	}

	function bytes(v) {
		if (!v) {
			return '0 KB';
		}
		if (v >= 1048576) {
			return (v / 1048576).toFixed(1) + ' MB';
		}
		return Math.round(v / 1024) + ' KB';
	}

	function esc(s) {
		return String(s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	function componentLabel(key) {
		var i = key.indexOf(':');
		if (i === -1) {
			return { badge: 'core', name: __('WordPress core', 'pulse-overlay') };
		}
		return { badge: key.slice(0, i), name: key.slice(i + 1) };
	}

	// ---------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------

	// Expandable rows: open/closed state lives here because the panel
	// rebuilds its innerHTML on every metric update.
	var openExp = {};

	function expRow(key, labelHtml, valueHtml, gradeClass, detailHtml) {
		return (
			'<div class="po-row po-clickable po-exp" data-exp="' + esc(key) + '" title="Click to expand">' +
			'<span class="po-label">' + labelHtml + '</span>' +
			'<span class="po-value ' + (gradeClass || '') + '">' + valueHtml + '</span>' +
			'</div>' +
			'<div class="po-detail' + (openExp[key] ? ' open' : '') + '">' + detailHtml + '</div>'
		);
	}

	document.addEventListener('click', function (e) {
		var head = e.target && e.target.closest ? e.target.closest('.po-exp') : null;
		if (!head) {
			return;
		}
		var key = head.getAttribute('data-exp');
		openExp[key] = !openExp[key];
		var detail = head.nextElementSibling;
		if (detail && detail.classList.contains('po-detail')) {
			detail.classList.toggle('open', !!openExp[key]);
		}
	});

	function row(label, value, gradeClass, title) {
		return (
			'<div class="po-row"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
			'<span class="po-label">' + esc(label) + '</span>' +
			'<span class="po-value ' + (gradeClass || '') + '">' + value + '</span>' +
			'</div>'
		);
	}

	function section(title, rowsHtml) {
		return (
			'<div class="po-section">' +
			'<div class="po-section-title">' + esc(title) + '</div>' +
			rowsHtml +
			'</div>'
		);
	}

	function renderPanel() {
		var res = collectResources();
		var dom = domNodeCount();
		var html = '';

		// --- Server ---
		if (server) {
			var sqlValue = server.sql.count + ' q';
			if (server.sql.time !== null) {
				sqlValue += ' · ' + secs(server.sql.time);
			}
			// Grade SQL by total time when available — query count alone
			// says nothing about cost (170 fast queries beat 20 slow ones).
			var sqlGrade = server.sql.time !== null
				? grade(server.sql.time, 0.1, 0.5)
				: grade(server.sql.count, 100, 200);
			var rows =
				row(__('PHP time', 'pulse-overlay'), secs(server.phpTime), grade(server.phpTime, 0.5, 1.5)) +
				row(
					__('SQL', 'pulse-overlay'),
					sqlValue,
					sqlGrade,
					server.sql.logged ? '' : __('Enable the overlay and reload to log query timings', 'pulse-overlay')
				) +
				row(__('Memory', 'pulse-overlay'), bytes(server.memory) + ' / ' + esc(server.memLimit), grade(server.memory, 33554432, 67108864)) +
				row(__('Enqueued', 'pulse-overlay'), server.assets.scripts + ' js · ' + server.assets.styles + ' css', '');
			if (server.autoload && server.autoload.total) {
				rows += row(
					__('Autoload', 'pulse-overlay'),
					bytes(server.autoload.total),
					grade(server.autoload.total, 819200, 2097152),
					__('Options loaded from the DB on every request', 'pulse-overlay')
				);
			}
			if (server.timelineTop) {
				var phaseShare = server.phpTime ? server.timelineTop.delta / server.phpTime : 0;
				rows += row(
					__('Longest phase', 'pulse-overlay'),
					esc(server.timelineTop.h) + ' · +' + Math.round(server.timelineTop.delta * 1000) + ' ms',
					phaseShare > 0.3 ? 'poor' : phaseShare > 0.15 ? 'warn' : '',
					__('The lifecycle phase that ate the biggest share of PHP time', 'pulse-overlay')
				);
			}
			html += section(__('Server', 'pulse-overlay'), rows);

			if (!server.sql.logged) {
				html +=
					'<div class="po-hint">' + esc(__('Query log is off — reload the page to capture per-plugin SQL timings.', 'pulse-overlay')) + '</div>';
			}

			// --- Remote HTTP (server-side wp_remote_* calls) ---
			if (server.http && server.http.length) {
				var httpTotal = 0;
				var hRows = server.http
					.map(function (hc) {
						httpTotal += hc.time;
						var srcKey = hc.component || 'core';
						var srcName = (server.names && server.names[srcKey]) || componentLabel(srcKey).name;
						var bad = hc.code === 'ERR' || parseInt(hc.code, 10) >= 400;
						return (
							'<div class="po-row" title="' + esc(srcName + ' → ' + hc.url + ' — HTTP ' + hc.code) + '">' +
							'<span class="po-label">' + esc(hc.host) + '</span>' +
							'<span class="po-value ' + (bad ? 'poor' : grade(hc.time, 0.2, 1)) + '">' +
							esc(secs(hc.time) + ' · ' + hc.code) + '</span>' +
							'</div>'
						);
					})
					.join('');
				hRows =
					row(__('Total', 'pulse-overlay'), server.http.length + ' · ' + secs(httpTotal), grade(httpTotal, 0.2, 1),
						__('Time spent inside wp_remote_* during page generation', 'pulse-overlay')) + hRows;
				html += section(__('Remote HTTP', 'pulse-overlay'), hRows);
			}

			// --- Autoload top offenders (data present with add-ons) ---
			if (server.autoload && server.autoload.top && server.autoload.top.length) {
				var alRows = server.autoload.top
					.map(function (o) {
						return row(o.name, bytes(o.len), grade(o.len, 51200, 262144), o.name);
					})
					.join('');
				html += section(__('Autoload top', 'pulse-overlay'), alRows);
			}
		} else {
			html += '<div class="po-hint">' + esc(__('No server data on this page.', 'pulse-overlay')) + '</div>';
		}

		// --- Network ---
		html += section(
			__('Network', 'pulse-overlay'),
			row(__('TTFB', 'pulse-overlay'), ms(vitals.ttfb), grade(vitals.ttfb, 800, 1800)) +
			row(__('Requests', 'pulse-overlay'), String(res.count), grade(res.count, 50, 100)) +
			row(
				__('Transferred', 'pulse-overlay'),
				res.transfer || !res.count ? bytes(res.transfer) : __('from cache', 'pulse-overlay'),
				grade(res.transfer, 1572864, 3145728),
				__('Network bytes; cached responses count as 0', 'pulse-overlay')
			)
		);

		// --- AJAX / REST ---
		if (netCalls.length) {
			var aRows = netCalls
				.map(function (c) {
					var srvPart = c.srv ? ' · ' + c.srv.q + ' q' + (c.srv.qt !== null ? ' · ' + secs(c.srv.qt) : '') : '';
					if (c.srv && c.srv.h) {
						srvPart += ' · ' + c.srv.h + ' http';
					}
					var tip = c.name + ' — HTTP ' + c.status +
						(c.srv && c.srv.top ? ' | top: ' + c.srv.top : '') +
						(c.srv && c.srv.h ? ' | remote http: ' + c.srv.h + ' · ' + secs(c.srv.ht) : '');
					var g = c.status >= 400 || !c.status ? 'poor' : grade(c.dur, 300, 1000);
					return (
						'<div class="po-row" title="' + esc(tip) + '">' +
						'<span class="po-label"><i class="po-badge po-badge-' + esc(c.kind) + '">' +
						esc(c.kind) + '</i>' + esc(c.name) + '</span>' +
						'<span class="po-value ' + g + '">' + ms(c.dur) + esc(srvPart) + '</span>' +
						'</div>'
					);
				})
				.join('');
			html += section(__('AJAX / REST', 'pulse-overlay'), aRows);
		}

		// --- Rendering ---
		html += section(
			__('Rendering', 'pulse-overlay'),
			row(__('LCP', 'pulse-overlay'), ms(vitals.lcp), grade(vitals.lcp, 2500, 4000)) +
			(vitals.lcpEl ? row(__('LCP element', 'pulse-overlay'), esc(vitals.lcpEl), '', __('Largest Contentful Paint element', 'pulse-overlay')) : '') +
			row(__('CLS', 'pulse-overlay'), vitals.cls.toFixed(3), grade(vitals.cls, 0.1, 0.25)) +
			row(__('INP', 'pulse-overlay'), ms(vitals.inp), grade(vitals.inp, 200, 500), __('Worst interaction so far', 'pulse-overlay')) +
			row(__('DOM nodes', 'pulse-overlay'), String(dom), grade(dom, 1500, 3000)) +
			row(__('Long tasks', 'pulse-overlay'), String(vitals.longTasks), grade(vitals.longTasks, 2, 6))
		);

		// --- Components: merge PHP SQL cost with JS asset cost ---
		var merged = {};
		if (server && server.sql.byComponent) {
			server.sql.byComponent.forEach(function (c) {
				merged[c.name] = { sqlCount: c.count, sqlTime: c.time, reqCount: 0, transfer: 0 };
			});
		}
		Object.keys(res.byComponent).forEach(function (key) {
			if (!merged[key]) {
				merged[key] = { sqlCount: 0, sqlTime: 0, reqCount: 0, transfer: 0 };
			}
			merged[key].reqCount = res.byComponent[key].count;
			merged[key].transfer = res.byComponent[key].transfer;
		});

		var keys = Object.keys(merged).sort(function (a, b) {
			return (merged[b].sqlTime || 0) - (merged[a].sqlTime || 0) || merged[b].transfer - merged[a].transfer;
		});

		if (keys.length) {
			var compRows = keys
				.map(function (key) {
					var c = merged[key];
					var label = componentLabel(key);
					var fullName = (server && server.names && server.names[key]) || label.name;
					var parts = [];
					if (c.sqlCount) {
						parts.push(c.sqlCount + ' q · ' + secs(c.sqlTime));
					}
					if (c.reqCount) {
						parts.push(c.reqCount + ' req · ' + bytes(c.transfer));
					}
					var stats = parts.join(' | ') || '—';
					var labelHtml =
						'<i class="po-badge po-badge-' + esc(label.badge) + '">' + esc(label.badge) + '</i>' +
						esc(fullName);
					// Plugin passport (added by add-ons): expandable drill-down.
					var pp = server && server.passport && server.passport[key];
					if (pp && ((pp.q && pp.q.length) || (pp.http && pp.http.length))) {
						var det = '';
						(pp.q || []).forEach(function (e) {
							det += '<div>' + esc(secs(e.time)) + ' · ' + esc(e.sql) + '</div>';
						});
						(pp.http || []).forEach(function (e) {
							det += '<div>http ' + esc(e.host) + ' · ' + esc(secs(e.time)) + '</div>';
						});
						return expRow('comp:' + key, labelHtml, esc(stats), '', det);
					}
					return (
						'<div class="po-row" title="' + esc(fullName + ' — ' + stats) + '">' +
						'<span class="po-label">' + labelHtml + '</span>' +
						'<span class="po-value">' + esc(stats) + '</span>' +
						'</div>'
					);
				})
				.join('');
			html += section(__('Components', 'pulse-overlay'), compRows);
		}

		// --- Timeline (lifecycle hook markers) ---
		if (server && server.timeline && server.timeline.length > 1) {
			var total = server.phpTime || server.timeline[server.timeline.length - 1].t;
			var prev = 0;
			var tRows = server.timeline
				.map(function (mrk) {
					var delta = mrk.t - prev;
					prev = mrk.t;
					var share = total ? delta / total : 0;
					var g = share > 0.3 ? 'poor' : share > 0.15 ? 'warn' : '';
					return row(mrk.h, secs(mrk.t) + ' <span class="po-tl-delta ' + g + '">+' +
						Math.round(delta * 1000) + '</span>', '', __('elapsed · +ms since previous marker', 'pulse-overlay'));
				})
				.join('');
			html += section(__('Timeline', 'pulse-overlay'), tRows);
		}

		// --- Slowest queries ---
		if (server && server.sql.slowest && server.sql.slowest.length) {
			var qRows = server.sql.slowest
				.map(function (q, qi) {
					// Attribution is only present when an add-on unlocked it.
					var srcHtml = '';
					var tipName = '';
					if (q.component) {
						var label = componentLabel(q.component);
						var srcName = (server.names && server.names[q.component]) || label.name;
						srcHtml = '<span class="po-query-src po-src-' + esc(label.badge) + '">' + esc(srcName) + '</span>';
						tipName = srcName + ' — ';
					}
					var inner =
						'<span class="po-query-time ' + grade(q.time, 0.005, 0.05) + '">' + secs(q.time) +
						(q.explain && q.explain.bad ? ' ⚠' : '') + '</span>' +
						srcHtml +
						'<span class="po-query-sql">' + esc(q.sql) + '</span>';
					// EXPLAIN data (added by add-ons) makes the row expandable.
					if (q.explain) {
						var expKey = 'sq:' + qi;
						var det = q.explain.rows.map(function (r) { return '<div>' + esc(r) + '</div>'; }).join('') +
							'<div class="po-sql">' + esc(q.sql) + '</div>';
						return (
							'<div class="po-query po-clickable po-exp" data-exp="' + expKey + '" title="' +
							esc(tipName + 'EXPLAIN — click to expand') + '">' + inner + '</div>' +
							'<div class="po-detail' + (openExp[expKey] ? ' open' : '') + '">' + det + '</div>'
						);
					}
					return '<div class="po-query" title="' + esc(tipName + q.sql) + '">' + inner + '</div>';
				})
				.join('');
			html += section(__('Slowest queries', 'pulse-overlay'), qRows);
		}

		html += renderHistory();

		// Sections registered by add-ons via window.Pulse.registerSection().
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

		if (server) {
			html +=
				// translators: 1: PHP version number, 2: WordPress version number.
				'<div class="po-footer">' + esc(sprintf(__('PHP %1$s · WP %2$s', 'pulse-overlay'), server.env.php, server.env.wp)) + '</div>';
		}

		panel.innerHTML = html;
	}

	function renderPill() {
		var t = server ? secs(server.phpTime) : ms(vitals.lcp);
		var worst = 'good';
		var grades = [
			grade(server && server.phpTime, 0.5, 1.5),
			grade(vitals.lcp, 2500, 4000),
			grade(vitals.cls, 0.1, 0.25)
		];
		if (grades.indexOf('poor') !== -1) {
			worst = 'poor';
		} else if (grades.indexOf('warn') !== -1) {
			worst = 'warn';
		}
		pill.innerHTML = '<i class="po-dot ' + worst + '"></i>' + t;
	}

	var renderQueued = false;
	function scheduleRender() {
		if (renderQueued || !root) {
			return;
		}
		renderQueued = true;
		requestAnimationFrame(function () {
			renderQueued = false;
			renderPill();
			if (panel.classList.contains('open')) {
				renderPanel();
			}
		});
	}

	// ---------------------------------------------------------------------
	// Shell
	// ---------------------------------------------------------------------

	function setCookie(on) {
		var secure = location.protocol === 'https:' ? '; Secure' : '';
		document.cookie = on
			? COOKIE + '=1; path=/; max-age=31536000; SameSite=Lax' + secure
			: COOKIE + '=; path=/; max-age=0; SameSite=Lax' + secure;
	}

	function togglePanel(force) {
		var open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
		panel.classList.toggle('open', open);
		try {
			localStorage.setItem(LS_KEY, open ? '1' : '0');
		} catch (e) { /* private mode */ }
		if (open) {
			setCookie(true);
			renderPanel();
		}
	}

	function build() {
		root = document.createElement('div');
		root.id = 'pulse-overlay-root';

		pill = document.createElement('button');
		pill.className = 'po-pill';
		pill.type = 'button';
		pill.title = __('Pulse — performance overlay', 'pulse-overlay');
		pill.addEventListener('click', function () {
			togglePanel();
		});

		panel = document.createElement('div');
		panel.className = 'po-panel';

		root.appendChild(panel);
		root.appendChild(pill);
		document.body.appendChild(root);

		renderPill();

		var open = false;
		try {
			open = localStorage.getItem(LS_KEY) === '1';
		} catch (e) { /* private mode */ }
		if (open) {
			togglePanel(true);
		}

		// Admin-bar node: show/hide the whole overlay; turning it off also
		// drops the SAVEQUERIES cookie so production stops paying for the log.
		var abNode = document.getElementById('wp-admin-bar-pulse-overlay');
		if (abNode) {
			abNode.addEventListener('click', function (e) {
				e.preventDefault();
				var hidden = root.classList.toggle('po-hidden');
				setCookie(!hidden);
			});
		}

		// The cookie arms SAVEQUERIES for the next load even before the
		// panel is first opened.
		setCookie(true);
	}

	// Public extension API for add-ons (Pulse Pro etc.). Add-on scripts are
	// enqueued with this file as a dependency, so the object exists by the
	// time they evaluate.
	var extraSections = [];
	window.Pulse = {
		registerSection: function (id, render, order) {
			extraSections.push({ id: id, render: render, order: order || 100 });
			scheduleRender();
		},
		helpers: {
			row: row,
			expRow: expRow,
			section: section,
			esc: esc,
			ms: ms,
			secs: secs,
			bytes: bytes,
			grade: grade,
			componentLabel: componentLabel
		},
		getServer: function () { return server; },
		vitals: vitals,
		refresh: function () { scheduleRender(); }
	};

	function init() {
		try {
			server = readServerData();
			collectVitals();
			build();
			watchServerData();
			armSampling();
			initNetSpy();
			// Debug handle: inspect collected data from the console.
			window.pulseOverlay = {
				get server() { return server; },
				vitals: vitals
			};
		} catch (e) {
			/* never break the host page */
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();

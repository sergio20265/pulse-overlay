/**
 * Arvexa Performance Overlay.
 *
 * Reads the server-side JSON blob printed by Arvexa_Performance_Collector, collects
 * browser-side metrics (Web Vitals, DOM size, network cost) and renders
 * a floating panel. Everything is wrapped so a failure here can never
 * break the host page.
 */
(function () {
	'use strict';

	var LS_KEY = 'arvexaPerformanceOverlayOpen';
	var config = window.ArvexaPerformanceOverlayConfig || {};

	// wp-i18n is declared as a script dependency, but guard anyway — this
	// file must never break the host page even if load order is disturbed.
	// Standalone builds pass their own translator; WP uses wp-i18n.
	var i18n = config.i18n || (window.wp && window.wp.i18n) || {};
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
			if (window.__arvexaPerformanceOverlayData && typeof window.__arvexaPerformanceOverlayData === 'object') {
				return window.__arvexaPerformanceOverlayData;
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
				vitals.lcpEntry = last;
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
			if (key === 'plugin:arvexa-performance-overlay' || key === 'plugin:arvexa-performance-pro') {
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

	// Standard LCP breakdown (TTFB → load delay → load duration → render
	// delay) plus concrete causes found on the LCP element itself. Computed
	// on demand: the LCP entry keeps changing until the first input.
	function analyzeLcp() {
		var entry = vitals.lcpEntry;
		if (!entry || vitals.lcp === null) {
			return null;
		}
		var ttfb = vitals.ttfb || 0;
		var lcp = vitals.lcp;
		var el = entry.element;
		var url = entry.url || '';
		var res = null;
		if (url && performance.getEntriesByName) {
			res = performance.getEntriesByName(url, 'resource')[0] || null;
		}

		var phases = { ttfb: Math.min(ttfb, lcp), loadDelay: 0, loadTime: 0, renderDelay: 0 };
		if (res) {
			// requestStart is 0 for cross-origin files without Timing-Allow-Origin.
			var reqStart = Math.max(ttfb, res.requestStart || res.startTime);
			var end = Math.min(Math.max(reqStart, res.responseEnd), lcp);
			phases.loadDelay = Math.max(0, reqStart - ttfb);
			phases.loadTime = Math.max(0, end - reqStart);
			phases.renderDelay = Math.max(0, lcp - end);
		} else {
			// Text node or a resource we cannot see: everything after TTFB is render.
			phases.renderDelay = Math.max(0, lcp - phases.ttfb);
		}

		var tag = el && el.tagName ? el.tagName.toLowerCase() : '';
		var isImg = tag === 'img';
		var info = {
			kind: !url ? 'text' : isImg ? 'image' : tag === 'video' ? 'video' : 'background',
			url: url,
			size: res ? (res.encodedBodySize || res.transferSize || 0) : 0,
			phases: phases,
			hints: []
		};
		var hint = function (level, text) {
			info.hints.push({ level: level, text: text });
		};

		try {
			var preloaded = false;
			if (url) {
				var links = document.querySelectorAll('link[rel~="preload"][as="image"]');
				for (var i = 0; i < links.length; i++) {
					var href = links[i].href || '';
					var set = links[i].getAttribute('imagesrcset') || '';
					if (href === url || (set && set.indexOf(url.split('?')[0].split('/').pop()) !== -1)) {
						preloaded = true;
					}
				}
			}

			if (isImg && el.getAttribute('loading') === 'lazy') {
				hint('poor', __('LCP image has loading="lazy" — the browser waits for layout before fetching it. Remove lazy-loading from this image.', 'arvexa-performance-overlay'));
			}
			if (info.kind === 'background' && !preloaded) {
				hint('warn', __('LCP image is a CSS background — it is discovered only after the stylesheet loads. Use an <img> or preload it.', 'arvexa-performance-overlay'));
			}
			if (isImg && el.getAttribute('fetchpriority') !== 'high' && !preloaded) {
				hint('warn', __('LCP image has no fetchpriority="high" — it competes with other images for bandwidth.', 'arvexa-performance-overlay'));
			}
			if (isImg && el.naturalWidth) {
				var needed = Math.round(el.getBoundingClientRect().width * (window.devicePixelRatio || 1));
				if (needed > 0 && el.naturalWidth > needed * 1.5 && el.naturalWidth - needed > 200) {
					// translators: 1: intrinsic image width in px, 2: width actually needed in px.
					hint('warn', sprintf(__('Image is %1$spx wide but only %2$spx is needed — check srcset/sizes or the image size used by the theme.', 'arvexa-performance-overlay'), el.naturalWidth, needed));
				}
			}
			if (info.size > 200 * 1024) {
				// translators: %1$s: file size, e.g. "480 KB".
				hint(info.size > 500 * 1024 ? 'poor' : 'warn', sprintf(__('LCP file weighs %1$s — compress it.', 'arvexa-performance-overlay'), bytes(info.size)));
			}
			if (url && info.size > 100 * 1024 && !/\.(webp|avif)(\?|$)/i.test(url)) {
				hint('warn', __('LCP image is not WebP/AVIF — a modern format is usually 30–50% smaller.', 'arvexa-performance-overlay'));
			}
			if (url && phases.loadDelay > 500 && phases.loadDelay > lcp * 0.25 && !preloaded) {
				hint('warn', __('The LCP image starts downloading late — it is not in the initial HTML or is injected by JavaScript (slider, lazy-load script). Preload it.', 'arvexa-performance-overlay'));
			}
			if (phases.renderDelay > 500 && phases.renderDelay > lcp * 0.3) {
				hint('warn', __('Long gap between loading and painting — render-blocking CSS/JS, a web font, or a script revealing the content (animations, sliders).', 'arvexa-performance-overlay'));
			}
			if (phases.ttfb > 800 && phases.ttfb > lcp * 0.4) {
				hint('warn', __('Most of LCP is waiting for the server — see PHP time and SQL above, or enable page caching.', 'arvexa-performance-overlay'));
			}
		} catch (e) {
			/* diagnostics are best-effort */
		}

		info.hints.sort(function (a, b) {
			return (b.level === 'poor') - (a.level === 'poor');
		});
		return info;
	}

	function domNodeCount() {
		return document.getElementsByTagName('*').length;
	}

	// ---------------------------------------------------------------------
	// AJAX / REST spy: patch fetch + XHR, read the X-Arvexa-Performance server header
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
			if (name === 'arvexa_performance_overlay_sample') {
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

	function parseArvexaPerformanceHeader(raw) {
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
								finishCall(info, started, resp.status, parseArvexaPerformanceHeader(resp.headers.get('X-Arvexa-Performance')));
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
			this.__arvexaPerformanceUrl = url;
			return xhrOpen.apply(this, arguments);
		};
		XMLHttpRequest.prototype.send = function (body) {
			try {
				var info = requestName(this.__arvexaPerformanceUrl || '', bodyToString(body));
				if (info) {
					var xhr = this;
					var started = performance.now();
					xhr.addEventListener('loadend', function () {
						var srv = null;
						try {
							srv = parseArvexaPerformanceHeader(xhr.getResponseHeader('X-Arvexa-Performance'));
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
				server.history.ajax + '?action=arvexa_performance_overlay_sample',
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

		var html = row(__('Samples', 'arvexa-performance-overlay'), String(h.samples.length), '');

		if (!prevHash) {
			return section(__('History', 'arvexa-performance-overlay'), html);
		}

		var previous = samples.filter(function (s) { return s.env === prevHash; });
		var diff = envDiff(h.envs && h.envs[prevHash], h.envs && h.envs[h.envHash]);
		if (diff) {
			html += '<div class="po-hint po-env-diff">' + esc(diff.join(', ')) + '</div>';
		}

		var metrics = [
			{ key: 'phpTime', label: __('Δ PHP time', 'arvexa-performance-overlay'), fmt: secs },
			{ key: 'sqlCount', label: __('Δ SQL queries', 'arvexa-performance-overlay'), fmt: function (v) { return Math.round(v) + ' q'; } },
			{ key: 'sqlTime', label: __('Δ SQL time', 'arvexa-performance-overlay'), fmt: secs },
			{ key: 'lcp', label: __('Δ LCP', 'arvexa-performance-overlay'), fmt: ms },
			{ key: 'transfer', label: __('Δ Transferred', 'arvexa-performance-overlay'), fmt: bytes }
		];

		metrics.forEach(function (m) {
			var was = median(previous.map(function (s) { return s[m.key]; }));
			var now = median(current.map(function (s) { return s[m.key]; }));
			if (was === null || now === null) {
				return;
			}
			var delta = now - was;
			html += row(m.label, fmtDelta(delta, m.fmt), deltaGrade(delta, was), __('median now vs before the change', 'arvexa-performance-overlay'));
		});

		return section(__('History · since env change', 'arvexa-performance-overlay'), html);
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
			return { badge: 'core', name: __('WordPress core', 'arvexa-performance-overlay') };
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

	function pulseDashboard() {
		if (config.theme !== 'pulse') { return ''; }
		var device = window.matchMedia && window.matchMedia('(max-width: 782px)').matches ? 'Mobile' : 'Desktop';
		var cards = [
			['PHP', secs(server && server.phpTime), grade(server && server.phpTime, 0.5, 1.5), Math.min(100, Math.round((server && server.phpTime || 0) / 1.5 * 100))],
			['LCP', ms(vitals.lcp), grade(vitals.lcp, 2500, 4000), Math.min(100, Math.round((vitals.lcp || 0) / 4000 * 100))],
			['CLS', vitals.cls.toFixed(3), grade(vitals.cls, 0.1, 0.25), Math.min(100, Math.round(vitals.cls / 0.25 * 100))],
			['INP', ms(vitals.inp), grade(vitals.inp, 200, 500), Math.min(100, Math.round((vitals.inp || 0) / 500 * 100))]
		];
		return '<div class="po-pulse-overview"><div class="po-pulse-title"><b>Performance Pulse</b><small>Live metrics from this ' + device + ' browser</small></div><a class="po-pulse-pagespeed" href="https://pagespeed.web.dev/analysis?url=' + encodeURIComponent(window.location.href) + '" target="_blank" rel="noopener noreferrer">PageSpeed Insights ↗</a><div class="po-pulse-cards">' + cards.map(function (c) { return '<div class="po-pulse-card ' + c[2] + '"><span>' + c[0] + '</span><strong>' + c[1] + '</strong><i><em style="width:' + c[3] + '%"></em></i></div>'; }).join('') + '</div><p>For independent lab scores, use PageSpeed Insights and select Mobile or Desktop there.</p></div>';
	}

	function renderPanel() {
		var res = collectResources();
		var dom = domNodeCount();
		var html = pulseDashboard() + renderExtraSections(true);

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
				row(__('PHP time', 'arvexa-performance-overlay'), secs(server.phpTime), grade(server.phpTime, 0.5, 1.5)) +
				row(
					__('SQL', 'arvexa-performance-overlay'),
					sqlValue,
					sqlGrade,
					server.sql.logged ? '' : __('Enable SAVEQUERIES in wp-config.php to log query timings', 'arvexa-performance-overlay')
				) +
				row(__('Memory', 'arvexa-performance-overlay'), bytes(server.memory) + ' / ' + esc(server.memLimit), grade(server.memory, 33554432, 67108864)) +
				row(__('Enqueued', 'arvexa-performance-overlay'), server.assets.scripts + ' js · ' + server.assets.styles + ' css', '');
			if (server.autoload && server.autoload.total) {
				rows += row(
					__('Autoload', 'arvexa-performance-overlay'),
					bytes(server.autoload.total),
					grade(server.autoload.total, 819200, 2097152),
					__('Options loaded from the DB on every request', 'arvexa-performance-overlay')
				);
			}
			if (server.timelineTop) {
				var phaseShare = server.phpTime ? server.timelineTop.delta / server.phpTime : 0;
				rows += row(
					__('Longest phase', 'arvexa-performance-overlay'),
					esc(server.timelineTop.h) + ' · +' + Math.round(server.timelineTop.delta * 1000) + ' ms',
					phaseShare > 0.3 ? 'poor' : phaseShare > 0.15 ? 'warn' : '',
					__('The lifecycle phase that ate the biggest share of PHP time', 'arvexa-performance-overlay')
				);
			}
			html += section(__('Server', 'arvexa-performance-overlay'), rows);

			if (!server.sql.logged) {
				html +=
					'<div class="po-hint">' + esc(__('Query log is off — enable SAVEQUERIES in wp-config.php to capture per-plugin SQL timings.', 'arvexa-performance-overlay')) + '</div>';
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
					row(__('Total', 'arvexa-performance-overlay'), server.http.length + ' · ' + secs(httpTotal), grade(httpTotal, 0.2, 1),
						__('Time spent inside wp_remote_* during page generation', 'arvexa-performance-overlay')) + hRows;
				html += section(__('Remote HTTP', 'arvexa-performance-overlay'), hRows);
			}

			// --- Autoload top offenders (data present with add-ons) ---
			if (server.autoload && server.autoload.top && server.autoload.top.length) {
				var alRows = server.autoload.top
					.map(function (o) {
						return row(o.name, bytes(o.len), grade(o.len, 51200, 262144), o.name);
					})
					.join('');
				html += section(__('Autoload top', 'arvexa-performance-overlay'), alRows);
			}
		} else if (!config.standalone) {
			html += '<div class="po-hint">' + esc(__('No server data on this page.', 'arvexa-performance-overlay')) + '</div>';
		}

		// --- Network ---
		html += section(
			__('Network', 'arvexa-performance-overlay'),
			row(__('TTFB', 'arvexa-performance-overlay'), ms(vitals.ttfb), grade(vitals.ttfb, 800, 1800)) +
			row(__('Requests', 'arvexa-performance-overlay'), String(res.count), grade(res.count, 50, 100)) +
			row(
				__('Transferred', 'arvexa-performance-overlay'),
				res.transfer || !res.count ? bytes(res.transfer) : __('from cache', 'arvexa-performance-overlay'),
				grade(res.transfer, 1572864, 3145728),
				__('Network bytes; cached responses count as 0', 'arvexa-performance-overlay')
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
			html += section(__('AJAX / REST', 'arvexa-performance-overlay'), aRows);
		}

		// --- Rendering ---
		// Free panel names the top LCP cause; the full breakdown is an add-on section.
		var lcpInfo = analyzeLcp();
		var lcpHint = lcpInfo && lcpInfo.hints.length ? lcpInfo.hints[0] : null;
		html += section(
			__('Rendering', 'arvexa-performance-overlay'),
			row(__('LCP', 'arvexa-performance-overlay'), ms(vitals.lcp), grade(vitals.lcp, 2500, 4000)) +
			(vitals.lcpEl ? row(__('LCP element', 'arvexa-performance-overlay'), esc(vitals.lcpEl), '', __('Largest Contentful Paint element', 'arvexa-performance-overlay')) : '') +
			(lcpHint ? '<div class="po-hint po-hint-' + lcpHint.level + '">' + esc(lcpHint.text) + '</div>' : '') +
			row(__('CLS', 'arvexa-performance-overlay'), vitals.cls.toFixed(3), grade(vitals.cls, 0.1, 0.25)) +
			row(__('INP', 'arvexa-performance-overlay'), ms(vitals.inp), grade(vitals.inp, 200, 500), __('Worst interaction so far', 'arvexa-performance-overlay')) +
			row(__('DOM nodes', 'arvexa-performance-overlay'), String(dom), grade(dom, 1500, 3000)) +
			row(__('Long tasks', 'arvexa-performance-overlay'), String(vitals.longTasks), grade(vitals.longTasks, 2, 6))
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
			html += section(__('Components', 'arvexa-performance-overlay'), compRows);
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
						Math.round(delta * 1000) + '</span>', '', __('elapsed · +ms since previous marker', 'arvexa-performance-overlay'));
				})
				.join('');
			html += section(__('Timeline', 'arvexa-performance-overlay'), tRows);
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
			html += section(__('Slowest queries', 'arvexa-performance-overlay'), qRows);
		}

		// --- Repeated queries (same statement shape, N+1 candidates) ---
		var dupes = server && server.sql.dupes;
		if (dupes && dupes.groups) {
			var dRows = row(
				__('Redundant', 'arvexa-performance-overlay'),
				// translators: 1: number of redundant queries, 2: number of distinct repeated statements.
				esc(sprintf(__('%1$s q in %2$s patterns', 'arvexa-performance-overlay'), dupes.extra, dupes.groups)),
				grade(dupes.extra, 20, 60),
				__('Queries that repeat a statement already run on this page — usually a lookup inside a loop', 'arvexa-performance-overlay')
			);
			dRows += dupes.top
				.map(function (d, di) {
					// Attribution and call stack are only present when an add-on unlocked them.
					var srcHtml = '';
					var tipName = '';
					if (d.component) {
						var label = componentLabel(d.component);
						var srcName = (server.names && server.names[d.component]) || label.name;
						srcHtml = '<span class="po-query-src po-src-' + esc(label.badge) + '">' + esc(srcName) + '</span>';
						tipName = srcName + ' — ';
					}
					var sameTip = d.identical
						? __('identical every time — the result could be cached', 'arvexa-performance-overlay')
						: __('same shape, different values — batch into one query', 'arvexa-performance-overlay');
					var inner =
						'<span class="po-query-time ' + grade(d.count, 4, 10) + '">×' + d.count + '</span>' +
						srcHtml +
						'<span class="po-query-sql">' + esc(d.sql) + '</span>';
					if (d.stack && d.stack.length) {
						var expKey = 'dq:' + di;
						var det = '<div>' + esc(secs(d.time) + ' · ' + sameTip) + '</div>';
						if (d.components && Object.keys(d.components).length > 1) {
							det += '<div>' + Object.keys(d.components).map(function (k) {
								return esc(((server.names && server.names[k]) || componentLabel(k).name) + ' ×' + d.components[k]);
							}).join(' · ') + '</div>';
						}
						det += '<div class="po-sql">' + d.stack.map(esc).join(' → ') + '</div>';
						return (
							'<div class="po-query po-clickable po-exp" data-exp="' + expKey + '" title="' +
							esc(tipName + __('call stack — click to expand', 'arvexa-performance-overlay')) + '">' + inner + '</div>' +
							'<div class="po-detail' + (openExp[expKey] ? ' open' : '') + '">' + det + '</div>'
						);
					}
					return '<div class="po-query" title="' + esc(tipName + secs(d.time) + ' · ' + sameTip) + '">' + inner + '</div>';
				})
				.join('');
			html += section(__('Repeated queries', 'arvexa-performance-overlay'), dRows);
		}

		html += renderHistory();

		html += renderExtraSections(false);

		if (server) {
			html +=
				// translators: 1: PHP version number, 2: WordPress version number.
				'<div class="po-footer">' + esc(sprintf(__('PHP %1$s · WP %2$s', 'arvexa-performance-overlay'), server.env.php, server.env.wp)) + '</div>';
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

	function togglePanel(force) {
		var open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
		panel.classList.toggle('open', open);
		try {
			localStorage.setItem(LS_KEY, open ? '1' : '0');
		} catch (e) { /* private mode */ }
		if (open) {
			renderPanel();
		}
	}

	function build() {
		root = document.createElement('div');
		root.id = 'arvexa-performance-overlay-root';
		if (config.theme === 'pulse') { root.className = 'po-theme-pulse'; }

		pill = document.createElement('button');
		pill.className = 'po-pill';
		pill.type = 'button';
		pill.title = __('Arvexa Performance Overlay', 'arvexa-performance-overlay');
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
			var stored = localStorage.getItem(LS_KEY);
			// Standalone users arrive via ?arvexa=1 to look at the panel, so open it unless they closed it before.
			open = stored === '1' || (stored === null && !!config.standalone);
		} catch (e) { /* private mode */ }
		if (open) {
			togglePanel(true);
		}

		// Admin-bar node: show or hide the overlay on the current page.
		var abNode = document.getElementById('wp-admin-bar-arvexa-performance-overlay');
		if (abNode) {
			abNode.addEventListener('click', function (e) {
				e.preventDefault();
				var hidden = root.classList.toggle('po-hidden');
			});
		}

	}

	// Public extension API for add-ons (Arvexa Performance Pro etc.). Add-on scripts are
	// enqueued with this file as a dependency, so the object exists by the
	// time they evaluate.
	var extraSections = [];
	window.ArvexaPerformanceOverlay = {
		registerSection: function (id, render, order) {
			extraSections.push({ id: id, render: render, order: typeof order === 'number' ? order : 100 });
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
		analyzeLcp: analyzeLcp,
		refresh: function () { scheduleRender(); }
	};

	function init() {
		try {
			server = readServerData();
			collectVitals();
			build();
			// Server JSON polling, history beacons and the WP AJAX spy only make sense inside WordPress.
			if (!config.standalone) {
				watchServerData();
				armSampling();
				initNetSpy();
			}
			// Debug handle: inspect collected data from the console.
			window.arvexaPerformanceOverlay = {
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

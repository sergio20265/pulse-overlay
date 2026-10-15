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
		// Modern browsers never fetch <script nomodule>, so it would never settle.
		if (t === 'SCRIPT' && el.noModule) {
			return '';
		}
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

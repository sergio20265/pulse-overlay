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

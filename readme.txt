=== Arvexa Performance Overlay ===
Contributors: balloodn
Tags: performance, profiler, debug, web vitals, sql queries
Requires at least: 5.3
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.2.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A live on-page performance overlay for admins. Install a plugin, reload the page — and see exactly what it cost you.

== Description ==

Arvexa Performance Overlay shows a small pill in the corner of every page — for administrators only. Click it and you get a live panel with everything that matters about the page you are looking at:

* **Server** — PHP generation time, SQL query count and total time, peak memory, number of enqueued scripts and styles, total size of autoloaded options, and the lifecycle phase that ate the biggest share of PHP time.
* **Components** — the cost of every plugin and theme on this page: SQL queries and time on the server side, requests and transferred bytes on the asset side. The answer to "which plugin slowed us down" in one glance.
* **Network** — TTFB, request count, transferred bytes.
* **Rendering** — LCP (and *which element* it is), CLS, INP, DOM node count, long tasks. Official Web Vitals thresholds, color-coded.
* **AJAX / REST** — every same-origin admin-ajax, wc-ajax and REST call timed as it happens.
* **Slowest queries** — the top queries with timings.
* **Repeated queries** — detects duplicate and N+1-shaped SQL statements so you can find cacheable or batchable work.
* **LCP diagnosis** — identifies the LCP element and its likely blocker, such as a CSS background, late discovery, a lazy image or server delay.
* **Performance Pulse** — an optional wide dark dashboard with visual PHP, LCP, CLS and INP indicators. It also links to PageSpeed Insights for independent Mobile and Desktop lab checks.

= How it works =

* Per-query plugin attribution uses the `log_query_custom_data` filter and a backtrace scan — no core hacks, no db.php drop-in.
* The plugin never enables or changes `SAVEQUERIES`. To collect query timings, a site administrator may explicitly add `define( 'SAVEQUERIES', true );` to `wp-config.php` before the "That's all, stop editing!" line.
* Visitors are never affected: for anyone without the capability the plugin adds no assets, no queries and no output.
* The Performance menu includes the theme setting, WordPress Core update status and a PageSpeed Insights shortcut.
* Add-ons can extend the panel via the `arvexa_performance_overlay_data` PHP filter and the `window.ArvexaPerformanceOverlay` JS API.

= Arvexa Performance Pro =

Deep diagnostics live in the Arvexa Performance Pro add-on: full hook timeline, server cost of every AJAX/REST call (X-Arvexa-Performance header), remote HTTP tracking (see what your shipping/payment APIs cost), WP_Query explorer with SQL and EXPLAIN, per-plugin drill-down cards, layout-shift attribution per element, and performance history with before/after comparison when a plugin is installed or updated.

== Installation ==

1. Upload the `arvexa-performance-overlay` folder to `/wp-content/plugins/`, or install through the WordPress plugin screen.
2. Activate the plugin.
3. Open any page of your site while logged in as an administrator — the Arvexa Performance Overlay pill appears bottom right. Click it to expand the panel.
4. Reload once more to get SQL timings and the per-plugin breakdown (see FAQ).

== Frequently Asked Questions ==

= Why is the per-plugin SQL breakdown empty on the first load? =

The plugin never enables `SAVEQUERIES`. To collect per-plugin query timings, add `define( 'SAVEQUERIES', true );` to `wp-config.php` before the "That's all, stop editing!" line, then reload the page.

= Does it slow down my site? =

For visitors — no: without the capability nothing is collected, enqueued or printed. For the logged-in admin the plugin adds one fast SQL aggregate. Query logging is active only when the site administrator has explicitly enabled `SAVEQUERIES`.

= Who can see the overlay? =

Users with the `manage_options` capability. Change it with the `arvexa_performance_overlay_capability` filter.

= Does it work in the admin area? =

Yes — the panel is available on both frontend and admin pages. Browser metrics like LCP are most meaningful on the frontend.

= Is any data sent anywhere? =

No. Everything is measured and displayed in your browser on your own site. Arvexa Performance Overlay makes no external requests.

== Screenshots ==

1. The compact Classic overlay with server, network and rendering signals.
2. Performance Pulse: a wide visual dashboard with PHP, LCP, CLS and INP cards.
3. The Performance settings page: choose the interface theme, check WordPress Core and open PageSpeed Insights.

== Changelog ==

= 1.2.0 =
* Added repeated-query detection for duplicate and N+1-shaped SQL statements.
* Added LCP cause analysis for lazy images, CSS backgrounds, discovery, image weight and server delay.
* Refined Performance Pulse and bundled the Performance settings, Core status and PageSpeed Insights workflow.


= 1.1.0 =
* Added the Performance Pulse dashboard theme with visual PHP, LCP, CLS and INP indicators.
* Added a WordPress admin settings page, Core version status and PageSpeed Insights shortcuts.
* Pulse uses a wide diagnostic grid; Pro adds responsive viewport context without faking mobile metrics.


= 1.0.2 =
* Compatibility release for WordPress 7.1.

= 1.0.1 =
* Compatibility release for WordPress 7.0. Updated the required PHP version metadata to match WordPress core.

= 1.0.0 =
* Initial public release.
* Server metrics: PHP time, SQL count/time, memory, enqueued assets, autoload size, longest lifecycle phase.
* Per-plugin/theme cost attribution (SQL via backtrace, assets via Resource Timing).
* Web Vitals: LCP + LCP element, CLS, INP, TTFB, DOM nodes, long tasks.
* Client-side AJAX/REST timing.
* Slowest queries list.
* Extension API for add-ons (`arvexa_performance_overlay_data` filter, `window.ArvexaPerformanceOverlay` JS API).

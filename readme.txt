=== Pulse — Live Performance Overlay ===
Contributors: arvexa
Tags: performance, profiler, debug, web vitals, sql queries
Requires at least: 5.3
Tested up to: 7.0
Requires PHP: 7.2
Stable tag: 1.0.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A live on-page performance overlay for admins. Install a plugin, reload the page — and see exactly what it cost you.

== Description ==

Pulse shows a small pill in the corner of every page — for administrators only. Click it and you get a live panel with everything that matters about the page you are looking at:

* **Server** — PHP generation time, SQL query count and total time, peak memory, number of enqueued scripts and styles, total size of autoloaded options, and the lifecycle phase that ate the biggest share of PHP time.
* **Components** — the cost of every plugin and theme on this page: SQL queries and time on the server side, requests and transferred bytes on the asset side. The answer to "which plugin slowed us down" in one glance.
* **Network** — TTFB, request count, transferred bytes.
* **Rendering** — LCP (and *which element* it is), CLS, INP, DOM node count, long tasks. Official Web Vitals thresholds, color-coded.
* **AJAX / REST** — every same-origin admin-ajax, wc-ajax and REST call timed as it happens.
* **Slowest queries** — the top queries with timings.

= How it works =

* Per-query plugin attribution uses the `log_query_custom_data` filter and a backtrace scan — no core hacks, no db.php drop-in.
* `SAVEQUERIES` cannot be enabled mid-request, so the overlay arms it with a cookie: timings and the per-plugin breakdown appear from the second page load. The cookie only enables collection — output is capability-gated (`manage_options` by default, filterable via `pulse_overlay_capability`).
* Visitors are never affected: for anyone without the capability the plugin adds no assets, no queries and no output.
* Add-ons can extend the panel via the `pulse_overlay_data` PHP filter and the `window.Pulse` JS API.

= Pulse Pro =

Deep diagnostics live in the Pulse Pro add-on: full hook timeline, server cost of every AJAX/REST call (X-Pulse header), remote HTTP tracking (see what your shipping/payment APIs cost), WP_Query explorer with SQL and EXPLAIN, per-plugin drill-down cards, layout-shift attribution per element, and performance history with before/after comparison when a plugin is installed or updated.

== Installation ==

1. Upload the `pulse-overlay` folder to `/wp-content/plugins/`, or install through the WordPress plugin screen.
2. Activate the plugin.
3. Open any page of your site while logged in as an administrator — the Pulse pill appears bottom right. Click it to expand the panel.
4. Reload once more to get SQL timings and the per-plugin breakdown (see FAQ).

== Frequently Asked Questions ==

= Why is the per-plugin SQL breakdown empty on the first load? =

Query logging (`SAVEQUERIES`) must be enabled before WordPress runs its first query, so it cannot be switched on mid-request. Pulse sets a cookie when the overlay is active; from the next page load query timings and attribution are collected. Toggling the overlay off from the "Pulse" admin-bar item removes the cookie and stops the logging overhead.

= Does it slow down my site? =

For visitors — no: without the capability nothing is collected, enqueued or printed. For the logged-in admin the overhead is one extra fast SQL aggregate and query logging while the overlay is armed.

= Who can see the overlay? =

Users with the `manage_options` capability. Change it with the `pulse_overlay_capability` filter.

= Does it work in the admin area? =

Yes — the panel is available on both frontend and admin pages. Browser metrics like LCP are most meaningful on the frontend.

= Is any data sent anywhere? =

No. Everything is measured and displayed in your browser on your own site. Pulse makes no external requests.

== Screenshots ==

1. The overlay panel: Server, Network, Rendering and Components at a glance.
2. Components — per-plugin SQL and asset cost.
3. Slowest queries with timings.
4. The pill — the only thing visible until you need more.

== Changelog ==

= 1.0.0 =
* Initial public release.
* Server metrics: PHP time, SQL count/time, memory, enqueued assets, autoload size, longest lifecycle phase.
* Per-plugin/theme cost attribution (SQL via backtrace, assets via Resource Timing).
* Web Vitals: LCP + LCP element, CLS, INP, TTFB, DOM nodes, long tasks.
* Client-side AJAX/REST timing.
* Slowest queries list.
* Extension API for add-ons (`pulse_overlay_data` filter, `window.Pulse` JS API).

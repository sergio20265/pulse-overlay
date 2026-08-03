# Arvexa Performance Overlay

A live on-page performance overlay for WordPress admins. Install a new plugin,
reload the page, and immediately see what it cost you.

This is the free core. Deep diagnostics (full hook timeline, server cost of
AJAX/REST calls, remote HTTP tracking, history with before/after comparison)
live in the **Arvexa Performance Pro** add-on, which plugs in via the `arvexa_performance_overlay_data`
PHP filter and the `window.ArvexaPerformanceOverlay` JS API (`registerSection`, helpers). The
core records cheaply and renders whatever data is present, so Pro ships no
duplicate rendering code.

## What it shows

- **Server**: PHP generation time, SQL query count + total time, peak memory,
  number of enqueued scripts/styles.
- **Network**: TTFB, request count, bytes transferred.
- **Rendering**: LCP, CLS, INP (worst interaction so far), DOM node count,
  long tasks.
- **Components**: per-plugin / per-theme cost — SQL queries and time on the
  PHP side, requests and transferred bytes on the asset side.
- **Slowest queries**: top 3 with timings (full attributed list + EXPLAIN — Pro).
- **Longest phase**: one Server row naming the lifecycle phase that ate the
  biggest share of PHP time (full timeline — Pro).
- **LCP element**: which element is the Largest Contentful Paint (per-element
  CLS attribution — Pro).
- **Autoload**: total size of autoloaded options (top offenders — Pro).

## How it works

- Server metrics are collected by `Arvexa_Performance_Collector` and printed as a JSON blob
  in the footer; the overlay JS reads it and adds browser-side metrics via
  `PerformanceObserver`.
- Per-query plugin attribution uses the `log_query_custom_data` filter
  (WP 5.3+) and a backtrace scan mapping the calling file to
  `plugins/<slug>`, `themes/<slug>`, `mu-plugins/<slug>` or core.
- `SAVEQUERIES` cannot be enabled mid-request, so the overlay sets a
  `arvexa_performance_overlay_on` cookie; from the **next** page load query logging is
  active. The cookie only enables collection — output is capability-gated
  (`manage_options` by default, filterable via `arvexa_performance_overlay_capability`),
  so a forged cookie leaks nothing. Toggling the overlay off from the admin
  bar drops the cookie and stops the logging overhead.

## Install

Copy the `arvexa-performance-overlay` folder into `wp-content/plugins/` and activate.
The overlay pill appears bottom-right for administrators only. Click the pill
to expand the panel; use the **Arvexa Performance Overlay** admin-bar item to hide the overlay
entirely (and disable query logging).

## Notes / roadmap

- First page load after activation shows query *count* only; timings and
  per-plugin breakdown appear from the second load (cookie → `SAVEQUERIES`).
- INP is an approximation (worst `event` entry with an `interactionId`).
- **AJAX / REST**: fetch and XHR are patched (safely, pass-through on any
  error) to time same-origin admin-ajax / wc-ajax / REST calls client-side.
  Server cost per call (`X-Arvexa-Performance` header) is added by Pro.
- Ideas next: packaging for wordpress.org, settings page.

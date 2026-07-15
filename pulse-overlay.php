<?php
/**
 * Plugin Name: Pulse — Live Performance Overlay
 * Plugin URI:  https://plugins.arvexa.ru/pulse.html
 * Description: A live on-page performance overlay for admins: PHP time, SQL queries attributed per plugin, memory, autoload size, Web Vitals (LCP / CLS / INP / TTFB), DOM size and network cost.
 * Version:     1.0.0
 * Author:      Arvexa
 * Author URI:  https://arvexa.ru
 * License:     GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: pulse-overlay
 * Requires at least: 5.3
 * Requires PHP: 7.2
 */

defined( 'ABSPATH' ) || exit;

define( 'PULSE_OVERLAY_VERSION', '1.0.0' );
define( 'PULSE_OVERLAY_DIR', plugin_dir_path( __FILE__ ) );
define( 'PULSE_OVERLAY_URL', plugin_dir_url( __FILE__ ) );

/*
 * SAVEQUERIES must be defined before queries run, so it cannot be enabled
 * "on demand" from a settings screen. Instead, when an admin switches the
 * overlay on, the JS sets a cookie and query logging kicks in from the next
 * page load. The cookie only enables collection — output is still gated by
 * capability, so a forged cookie leaks nothing.
 */
// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- presence check only: the cookie merely arms collection; all output stays capability-gated.
if ( ! defined( 'SAVEQUERIES' ) && ! empty( $_COOKIE['pulse_overlay_on'] ) ) {
	define( 'SAVEQUERIES', true );
}

require PULSE_OVERLAY_DIR . 'includes/class-pulse-collector.php';

Pulse_Collector::instance();

/**
 * Extension point for add-ons (Pulse Pro): they hook the
 * 'pulse_overlay_data' filter to enrich the panel payload and
 * register their own modules from here on.
 */
do_action( 'pulse_overlay_loaded' );

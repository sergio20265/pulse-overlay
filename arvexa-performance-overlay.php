<?php
/**
 * Plugin Name: Arvexa Performance Overlay
 * Plugin URI:  https://plugins.arvexa.ru/performance.html
 * Description: A live on-page performance overlay for admins: PHP time, SQL queries attributed per plugin, memory, autoload size, Web Vitals (LCP / CLS / INP / TTFB), DOM size and network cost.
 * Version:     1.0.0
 * Author:      Arvexa
 * Author URI:  https://arvexa.ru
 * License:     GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: arvexa-performance-overlay
 * Requires at least: 5.3
 * Requires PHP: 7.2
 */

defined( 'ABSPATH' ) || exit;

define( 'ARVEXA_PERFORMANCE_OVERLAY_VERSION', '1.0.0' );
define( 'ARVEXA_PERFORMANCE_OVERLAY_DIR', plugin_dir_path( __FILE__ ) );
define( 'ARVEXA_PERFORMANCE_OVERLAY_URL', plugin_dir_url( __FILE__ ) );


require ARVEXA_PERFORMANCE_OVERLAY_DIR . 'includes/class-arvexa-performance-collector.php';

Arvexa_Performance_Collector::instance();

/**
 * Extension point for add-ons (Arvexa Performance Pro): they hook the
 * 'arvexa_performance_overlay_data' filter to enrich the panel payload and
 * register their own modules from here on.
 */
do_action( 'arvexa_performance_overlay_loaded' );

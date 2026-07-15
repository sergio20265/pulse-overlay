<?php
/**
 * Collects server-side metrics and prints them as a JSON blob for the overlay.
 *
 * @package Pulse_Overlay
 */

defined( 'ABSPATH' ) || exit;

class Pulse_Collector {

	/** @var Pulse_Collector|null */
	private static $instance = null;

	/** @var bool Whether our overlay assets were enqueued on this request. */
	private $assets_enqueued = false;

	/** @var array Lifecycle hook markers: array( array( h, t ), ... ). */
	private $timeline = array();

	/** @var array Full slowest-queries list (with attribution) for add-ons. */
	private $sql_slowest_full = array();

	/** @var string Normalized path to the plugins directory. */
	private $plugin_dir;

	/** @var string Normalized path to the mu-plugins directory. */
	private $mu_dir;

	/** @var string Normalized path to the themes root. */
	private $theme_dir;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		$this->plugin_dir = wp_normalize_path( WP_PLUGIN_DIR );
		$this->mu_dir     = wp_normalize_path( WPMU_PLUGIN_DIR );
		$this->theme_dir  = wp_normalize_path( get_theme_root() );

		// Attribution must be registered unconditionally: queries run before
		// we know who the current user is.
		add_filter( 'log_query_custom_data', array( $this, 'attach_component' ), 10, 5 );

		$this->register_timeline_markers();

		add_action( 'init', array( $this, 'maybe_hook_output' ) );
	}

	public function maybe_hook_output() {
		if ( ! $this->can_view() ) {
			return;
		}

		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_assets' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_assets' ) );

		// PHP_INT_MAX so we run after everything else and count as many
		// queries as possible. Queries fired after this point are missed.
		add_action( 'wp_print_footer_scripts', array( $this, 'print_data' ), PHP_INT_MAX );
		add_action( 'admin_print_footer_scripts', array( $this, 'print_data' ), PHP_INT_MAX );

		// Safety net: if a theme or optimizer prevented the footer hook from
		// printing, emit the blob on shutdown (browsers parse trailing
		// content into <body>, same trick Query Monitor uses).
		add_action( 'shutdown', array( $this, 'print_data_fallback' ), 0 );

		add_action( 'admin_bar_menu', array( $this, 'admin_bar_node' ), 100 );
	}

	/**
	 * Whether the current user may see overlay data. Shared with the
	 * AJAX/REST tracker.
	 */
	public static function allowed() {
		/**
		 * Filters the capability required to see the overlay.
		 *
		 * @param string $capability Default 'manage_options'.
		 */
		$cap = apply_filters( 'pulse_overlay_capability', 'manage_options' );
		return is_user_logged_in() && current_user_can( $cap );
	}

	private function can_view() {
		return self::allowed();
	}

	public function enqueue_assets() {
		$this->assets_enqueued = true;
		wp_enqueue_style(
			'pulse-overlay',
			PULSE_OVERLAY_URL . 'assets/pulse-overlay.css',
			array(),
			PULSE_OVERLAY_VERSION
		);
		wp_enqueue_script(
			'pulse-overlay',
			PULSE_OVERLAY_URL . 'assets/pulse-overlay.js',
			array( 'wp-i18n' ),
			PULSE_OVERLAY_VERSION,
			true
		);
		wp_set_script_translations( 'pulse-overlay', 'pulse-overlay', PULSE_OVERLAY_DIR . 'languages' );
	}

	public function admin_bar_node( $bar ) {
		$bar->add_node(
			array(
				'id'    => 'pulse-overlay',
				'title' => '<span class="ab-icon dashicons dashicons-performance" style="top:2px;"></span><span class="ab-label">Pulse</span>',
				'href'  => '#',
				'meta'  => array( 'title' => __( 'Toggle the performance overlay', 'pulse-overlay' ) ),
			)
		);
	}

	/**
	 * Attaches a component key (plugin:slug / theme:slug / mu-plugin:slug / core)
	 * to every logged query via the query backtrace.
	 *
	 * Runs on the 'log_query_custom_data' filter (WP 5.3+).
	 */
	public function attach_component( $data, $query, $query_time, $callstack, $query_start ) {
		if ( ! is_array( $data ) ) {
			$data = array();
		}
		$data['pulse_component'] = $this->component_from_backtrace();
		return $data;
	}

	/**
	 * Public: add-ons (e.g. remote-HTTP tracking) attribute their own
	 * events with the same backtrace scan used for SQL.
	 */
	public function component_from_backtrace() {
		$trace = debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 40 ); // phpcs:ignore

		foreach ( $trace as $frame ) {
			if ( empty( $frame['file'] ) ) {
				continue;
			}
			$file = wp_normalize_path( $frame['file'] );

			// mu-plugins first: WPMU_PLUGIN_DIR may sit inside wp-content
			// alongside plugins and must not be shadowed by the plugins check.
			if ( 0 === strpos( $file, $this->mu_dir . '/' ) ) {
				return 'mu-plugin:' . $this->first_segment( substr( $file, strlen( $this->mu_dir ) + 1 ) );
			}
			if ( 0 === strpos( $file, $this->plugin_dir . '/' ) ) {
				$slug = $this->first_segment( substr( $file, strlen( $this->plugin_dir ) + 1 ) );
				// Skip ourselves and add-ons: measurement callbacks sit on
				// top of every backtrace and must never claim the cost.
				if ( 'pulse-overlay' === $slug || 'pulse-pro' === $slug ) {
					continue;
				}
				return 'plugin:' . $slug;
			}
			if ( 0 === strpos( $file, $this->theme_dir . '/' ) ) {
				return 'theme:' . $this->first_segment( substr( $file, strlen( $this->theme_dir ) + 1 ) );
			}
		}

		return 'core';
	}

	private function first_segment( $relative ) {
		$relative = ltrim( $relative, '/' );
		$slash    = strpos( $relative, '/' );
		$segment  = ( false === $slash ) ? $relative : substr( $relative, 0, $slash );
		// A single-file plugin: strip the extension so "hello.php" reads as "hello".
		return preg_replace( '/\.php$/', '', $segment );
	}

	public function print_data() {
		static $printed = false;
		if ( $printed ) {
			return;
		}
		$printed = true;

		/**
		 * Filters the overlay payload. Add-ons enrich it with extra
		 * sections (full timeline, remote HTTP, history, ...).
		 *
		 * @param array $data Collected metrics.
		 */
		$data = apply_filters( 'pulse_overlay_data', $this->collect() );

		$json = wp_json_encode( $data );
		if ( false === $json ) {
			return;
		}

		// json_encode escapes "/" by default, so "</script>" cannot appear
		// inside the payload. The classic-script duplicate survives HTML
		// minifiers that strip type="application/json" blocks.
		echo '<script type="application/json" id="pulse-overlay-data">' . $json . '</script>' . "\n";
		echo '<script>window.__pulseData = ' . $json . ';</script>' . "\n";
	}

	public function print_data_fallback() {
		if ( ! $this->assets_enqueued ) {
			return;
		}
		if ( wp_doing_ajax() || wp_doing_cron() || ( function_exists( 'wp_is_json_request' ) && wp_is_json_request() ) ) {
			return;
		}
		if ( ( defined( 'REST_REQUEST' ) && REST_REQUEST ) || ( defined( 'XMLRPC_REQUEST' ) && XMLRPC_REQUEST ) || is_feed() ) {
			return;
		}
		// No-op if the footer hook already printed (static guard inside).
		$this->print_data();
	}

	private function collect() {
		global $wpdb, $wp_scripts, $wp_styles;

		// timer_stop() formats with the locale (comma decimals in ru_RU),
		// so compute the raw float ourselves.
		$php_time = isset( $GLOBALS['timestart'] ) ? microtime( true ) - $GLOBALS['timestart'] : null;

		$sql = array(
			'count'       => (int) $wpdb->num_queries,
			'time'        => null,
			'logged'      => defined( 'SAVEQUERIES' ) && SAVEQUERIES,
			'byComponent' => array(),
			'slowest'     => array(),
		);

		if ( $sql['logged'] && ! empty( $wpdb->queries ) && is_array( $wpdb->queries ) ) {
			$total      = 0.0;
			$components = array();
			$slowest    = array();

			foreach ( $wpdb->queries as $q ) {
				$time      = isset( $q[1] ) ? (float) $q[1] : 0.0;
				$custom    = isset( $q[4] ) && is_array( $q[4] ) ? $q[4] : array();
				$component = isset( $custom['pulse_component'] ) ? $custom['pulse_component'] : 'core';

				$total += $time;

				if ( ! isset( $components[ $component ] ) ) {
					$components[ $component ] = array(
						'name'  => $component,
						'count' => 0,
						'time'  => 0.0,
					);
				}
				$components[ $component ]['count']++;
				$components[ $component ]['time'] += $time;

				$slowest[] = array(
					'sql'       => $this->truncate_sql( isset( $q[0] ) ? $q[0] : '' ),
					// Raw SQL for add-ons (EXPLAIN); stripped from the blob.
					'sqlRaw'    => substr( isset( $q[0] ) ? (string) $q[0] : '', 0, 2000 ),
					'time'      => round( $time, 5 ),
					'component' => $component,
				);
			}

			usort(
				$components,
				static function ( $a, $b ) {
					return $b['time'] <=> $a['time'];
				}
			);
			usort(
				$slowest,
				static function ( $a, $b ) {
					return $b['time'] <=> $a['time'];
				}
			);

			foreach ( $components as &$c ) {
				$c['time'] = round( $c['time'], 5 );
			}
			unset( $c );

			$sql['time']        = round( $total, 5 );
			$sql['byComponent'] = array_values( $components );

			// Free panel gets the top 3 without attribution; the full
			// attributed list is exposed to add-ons via get_sql_slowest().
			$this->sql_slowest_full = array_slice( $slowest, 0, 5 );
			$sql['slowest']         = array_map(
				static function ( $q ) {
					return array(
						'sql'  => $q['sql'],
						'time' => $q['time'],
					);
				},
				array_slice( $slowest, 0, 3 )
			);
		}

		// Longest lifecycle phase — the free teaser for the full timeline.
		$timeline_top = null;
		$prev_t       = 0.0;
		foreach ( $this->timeline as $m ) {
			$delta  = $m['t'] - $prev_t;
			$prev_t = $m['t'];
			if ( null === $timeline_top || $delta > $timeline_top['delta'] ) {
				$timeline_top = array(
					'h'     => $m['h'],
					'delta' => round( $delta, 4 ),
				);
			}
		}

		// Total size of autoloaded options — read on every request, a
		// classic silent grower. One fast aggregate query, admin-only.
		$autoload_total = (int) $wpdb->get_var(
			"SELECT COALESCE(SUM(LENGTH(option_value)),0) FROM {$wpdb->options} WHERE autoload IN ('yes','on','auto-on','auto')"
		);

		return array(
			'names'       => $this->component_names(),
			'autoload'    => array( 'total' => $autoload_total ),
			'timelineTop' => $timeline_top,
			'phpTime'     => ( null !== $php_time ) ? round( $php_time, 4 ) : null,
			'memory'   => memory_get_peak_usage(),
			'memLimit' => (string) ini_get( 'memory_limit' ),
			'sql'      => $sql,
			'assets'   => array(
				'scripts' => ( $wp_scripts instanceof WP_Scripts ) ? count( $wp_scripts->done ) : 0,
				'styles'  => ( $wp_styles instanceof WP_Styles ) ? count( $wp_styles->done ) : 0,
			),
			'env'      => array(
				'php'   => PHP_VERSION,
				'wp'    => get_bloginfo( 'version' ),
				'admin' => is_admin(),
			),
		);
	}

	/**
	 * Timestamps the start of key lifecycle hooks. Deltas between markers
	 * show which phase of the request ate the time. Overhead is one
	 * no-op-cheap callback per hook.
	 */
	private function register_timeline_markers() {
		$hooks = array(
			// Frontend order.
			'plugins_loaded',
			'setup_theme',
			'after_setup_theme',
			'init',
			'wp_loaded',
			'parse_request',
			'parse_query',
			'wp',
			'template_redirect',
			'get_header',
			'wp_head',
			'loop_start',
			'loop_end',
			'wp_footer',
			// Admin extras (only those that fire get recorded).
			'admin_menu',
			'admin_init',
			'in_admin_header',
			'admin_footer',
		);

		foreach ( $hooks as $hook ) {
			add_action(
				$hook,
				function () use ( $hook ) {
					$this->mark( $hook );
				},
				-PHP_INT_MAX
			);
		}
	}

	/** @var array Hooks already recorded on the timeline. */
	private $marked = array();

	private function mark( $name ) {
		// First firing only: hooks like parse_query or loop_start re-fire
		// for every secondary WP_Query and would flood the timeline.
		if ( isset( $this->marked[ $name ] ) || ! isset( $GLOBALS['timestart'] ) ) {
			return;
		}
		$this->marked[ $name ] = true;
		$this->timeline[]      = array(
			'h' => $name,
			't' => round( microtime( true ) - $GLOBALS['timestart'], 4 ),
		);
	}

	/**
	 * Full lifecycle timeline for add-ons (the free panel shows only the
	 * longest phase).
	 */
	public function get_timeline() {
		return $this->timeline;
	}

	/**
	 * Full slowest-queries list with attribution for add-ons (populated
	 * during collect()).
	 */
	public function get_sql_slowest() {
		return $this->sql_slowest_full;
	}

	/**
	 * Maps component keys to human-readable names ("plugin:woocommerce" =>
	 * "WooCommerce") for hover tooltips in the overlay.
	 */
	private function component_names() {
		$names = array();

		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		foreach ( get_plugins() as $file => $headers ) {
			if ( empty( $headers['Name'] ) ) {
				continue;
			}
			$slug = $this->first_segment( $file );
			$names[ 'plugin:' . $slug ] = $headers['Name'];
		}

		$theme = wp_get_theme();
		$names[ 'theme:' . $theme->get_stylesheet() ] = $theme->get( 'Name' );
		$parent = $theme->parent();
		if ( $parent ) {
			$names[ 'theme:' . $parent->get_stylesheet() ] = $parent->get( 'Name' );
		}

		return $names;
	}

	private function truncate_sql( $sql ) {
		$sql = trim( preg_replace( '/\s+/', ' ', (string) $sql ) );
		if ( strlen( $sql ) > 160 ) {
			$sql = substr( $sql, 0, 157 ) . '…';
		}
		return $sql;
	}
}

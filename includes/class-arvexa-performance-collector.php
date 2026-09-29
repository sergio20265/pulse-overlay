<?php
/**
 * Collects server-side metrics and prints them as a JSON blob for the overlay.
 *
 * @package Arvexa_Performance_Overlay
 */

defined( 'ABSPATH' ) || exit;

class Arvexa_Performance_Collector {

	const SETTINGS_OPTION = 'arvexa_performance_overlay_settings';

	/** @var Arvexa_Performance_Collector|null */
	private static $instance = null;

	/** @var bool Whether our overlay assets were enqueued on this request. */
	private $assets_enqueued = false;

	/** @var array Lifecycle hook markers: array( array( h, t ), ... ). */
	private $timeline = array();

	/** @var array Full slowest-queries list (with attribution) for add-ons. */
	private $sql_slowest_full = array();

	/** @var array Full repeated-query list (with attribution) for add-ons. */
	private $sql_dupes_full = array();

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

		add_action( 'admin_menu', array( $this, 'register_settings_page' ) );
		add_action( 'admin_init', array( $this, 'register_settings' ) );
	}

	public function maybe_hook_output() {
		if ( ! $this->can_view() ) {
			return;
		}

		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_assets' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_assets' ) );

		// PHP_INT_MAX so we run after everything else and count as many
		// queries as possible. Queries fired after this point are missed.
		add_action( 'wp_print_footer_scripts', array( $this, 'print_data' ), 1 );
		add_action( 'admin_print_footer_scripts', array( $this, 'print_data' ), 1 );

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
		$cap = apply_filters( 'arvexa_performance_overlay_capability', 'manage_options' );
		return is_user_logged_in() && current_user_can( $cap );
	}

	private function can_view() {
		return self::allowed();
	}

	public function enqueue_assets() {
		$this->assets_enqueued = true;
		wp_enqueue_style(
			'arvexa-performance-overlay',
			ARVEXA_PERFORMANCE_OVERLAY_URL . 'assets/arvexa-performance-overlay.css',
			array(),
			ARVEXA_PERFORMANCE_OVERLAY_VERSION
		);
		wp_enqueue_script(
			'arvexa-performance-overlay',
			ARVEXA_PERFORMANCE_OVERLAY_URL . 'assets/arvexa-performance-overlay.js',
			array( 'wp-i18n' ),
			ARVEXA_PERFORMANCE_OVERLAY_VERSION,
			true
		);
		wp_set_script_translations( 'arvexa-performance-overlay', 'arvexa-performance-overlay', ARVEXA_PERFORMANCE_OVERLAY_DIR . 'languages' );

		wp_add_inline_script(
			'arvexa-performance-overlay',
			'window.ArvexaPerformanceOverlayConfig = ' . wp_json_encode( self::settings() ) . ';',
			'before'
		);
	}

	public function admin_bar_node( $bar ) {
		$bar->add_node(
			array(
				'id'    => 'arvexa-performance-overlay',
				'title' => '<span class="ab-icon dashicons dashicons-performance" style="top:2px;"></span><span class="ab-label">Arvexa Performance</span>',
				'href'  => '#',
				'meta'  => array( 'title' => __( 'Toggle the performance overlay', 'arvexa-performance-overlay' ) ),
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
		$data['arvexa_performance_component'] = $this->component_from_backtrace();
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
			$component = $this->component_from_file( $frame['file'] );
			// Skip ourselves and add-ons: measurement callbacks sit on
			// top of every backtrace and must never claim the cost.
			if ( 'core' === $component || self::is_own( $component ) ) {
				continue;
			}
			return $component;
		}

		return 'core';
	}

	/**
	 * Public: maps a PHP file to its component key. Used by the backtrace
	 * scan and by add-ons that attribute callbacks via reflection.
	 */
	public function component_from_file( $file ) {
		$file = wp_normalize_path( (string) $file );

		// mu-plugins first: WPMU_PLUGIN_DIR may sit inside wp-content
		// alongside plugins and must not be shadowed by the plugins check.
		if ( 0 === strpos( $file, $this->mu_dir . '/' ) ) {
			return 'mu-plugin:' . $this->first_segment( substr( $file, strlen( $this->mu_dir ) + 1 ) );
		}
		if ( 0 === strpos( $file, $this->plugin_dir . '/' ) ) {
			return 'plugin:' . $this->first_segment( substr( $file, strlen( $this->plugin_dir ) + 1 ) );
		}
		if ( 0 === strpos( $file, $this->theme_dir . '/' ) ) {
			return 'theme:' . $this->first_segment( substr( $file, strlen( $this->theme_dir ) + 1 ) );
		}
		return 'core';
	}

	/** Whether a component key is this plugin or its add-on. */
	public static function is_own( $component ) {
		return 'plugin:arvexa-performance-overlay' === $component || 'plugin:arvexa-performance-pro' === $component;
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
		$data = apply_filters( 'arvexa_performance_overlay_data', $this->collect() );

		$json = wp_json_encode( $data );
		if ( false === $json ) {
			return;
		}

		// json_encode escapes "/" by default, so "</script>" cannot appear
		// inside the payload. The classic-script duplicate survives HTML
		// minifiers that strip type="application/json" blocks.
		wp_add_inline_script(
			'arvexa-performance-overlay',
			'window.__arvexaPerformanceOverlayData = ' . $json . ';',
			'before'
		);
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
			$patterns   = array();

			foreach ( $wpdb->queries as $q ) {
				$time      = isset( $q[1] ) ? (float) $q[1] : 0.0;
				$custom    = isset( $q[4] ) && is_array( $q[4] ) ? $q[4] : array();
				$component = isset( $custom['arvexa_performance_component'] ) ? $custom['arvexa_performance_component'] : 'core';

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

				// Group by shape: the same statement with different literals
				// is the classic N+1 (e.g. post meta fetched inside a loop).
				$raw  = isset( $q[0] ) ? (string) $q[0] : '';
				$fp   = $this->fingerprint( $raw );
				$fkey = md5( $fp );
				if ( ! isset( $patterns[ $fkey ] ) ) {
					$patterns[ $fkey ] = array(
						'sql'        => $this->truncate_sql( $fp ),
						'count'      => 0,
						'time'       => 0.0,
						'variants'   => array(),
						'components' => array(),
						'stack'      => isset( $q[2] ) ? (string) $q[2] : '',
					);
				}
				$p = &$patterns[ $fkey ];
				$p['count']++;
				$p['time'] += $time;
				// Capped: only needed to tell "identical" from "same shape".
				if ( count( $p['variants'] ) < 50 ) {
					$p['variants'][ md5( $raw ) ] = true;
				}
				$p['components'][ $component ] = isset( $p['components'][ $component ] ) ? $p['components'][ $component ] + 1 : 1;
				unset( $p );
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
			$sql['dupes']       = $this->summarize_dupes( $patterns );

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
			'ui'          => self::settings(),
			'core'        => $this->core_status(),
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
	 * Full repeated-query list with attribution and call stack for add-ons
	 * (populated during collect()).
	 */
	public function get_sql_dupes() {
		return $this->sql_dupes_full;
	}

	/**
	 * Reduces a statement to its shape: string and numeric literals become
	 * "?", IN-lists collapse to one token. Table prefixes like wp_2_posts
	 * survive because the digit is not on a word boundary.
	 */
	private function fingerprint( $sql ) {
		// Bound regex cost on huge statements (bulk INSERTs, serialized blobs).
		$sql = substr( $sql, 0, 4000 );
		$out = preg_replace(
			array(
				"/'(?:[^'\\\\]|\\\\.)*'/s",
				'/"(?:[^"\\\\]|\\\\.)*"/s',
				'/\b\d+(?:\.\d+)?\b/',
				'/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/i',
				'/\s+/',
			),
			array( '?', '?', '?', 'IN (?, …)', ' ' ),
			$sql
		);
		// preg_replace returns null on backtrack-limit failure.
		return trim( null === $out ? $sql : $out );
	}

	/**
	 * Turns grouped query shapes into the payload: totals for everyone,
	 * top 3 unattributed for the free panel, full list kept for add-ons.
	 */
	private function summarize_dupes( $patterns ) {
		$repeated = array();
		$extra    = 0;
		foreach ( $patterns as $p ) {
			if ( $p['count'] < 2 ) {
				continue;
			}
			$extra += $p['count'] - 1;
			arsort( $p['components'] );
			$repeated[] = array(
				'sql'        => $p['sql'],
				'count'      => $p['count'],
				'time'       => round( $p['time'], 5 ),
				'identical'  => 1 === count( $p['variants'] ),
				'component'  => (string) key( $p['components'] ),
				'components' => $p['components'],
				'stack'      => $this->stack_tail( $p['stack'] ),
			);
		}

		usort(
			$repeated,
			static function ( $a, $b ) {
				return $b['count'] <=> $a['count'] ?: $b['time'] <=> $a['time'];
			}
		);

		$this->sql_dupes_full = array_slice( $repeated, 0, 10 );

		return array(
			'groups' => count( $repeated ),
			'extra'  => $extra,
			'top'    => array_map(
				static function ( $d ) {
					return array(
						'sql'       => $d['sql'],
						'count'     => $d['count'],
						'time'      => $d['time'],
						'identical' => $d['identical'],
					);
				},
				array_slice( $repeated, 0, 3 )
			),
		);
	}

	/**
	 * Last frames of wpdb's caller string ("a, b, c") — the nearest callers
	 * are what explains a loop.
	 */
	private function stack_tail( $stack ) {
		if ( '' === $stack ) {
			return array();
		}
		$frames = array_map( 'trim', explode( ',', $stack ) );
		return array_slice( $frames, -6 );
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

	/** Defaulted, sanitised interface preferences shared by frontend and admin. */
	public static function settings() {
		$settings = get_option( self::SETTINGS_OPTION, array() );
		$settings = is_array( $settings ) ? $settings : array();
		return wp_parse_args( $settings, array( 'theme' => 'classic' ) );
	}

	public function register_settings() {
		register_setting( 'arvexa_performance_overlay_settings', self::SETTINGS_OPTION, array( 'sanitize_callback' => array( $this, 'sanitize_settings' ) ) );
	}

	public function sanitize_settings( $settings ) {
		$settings = is_array( $settings ) ? $settings : array();
		return array(
			'theme' => isset( $settings['theme'] ) && 'pulse' === $settings['theme'] ? 'pulse' : 'classic',
		);
	}

	public function register_settings_page() {
		add_menu_page( __( 'Arvexa Performance', 'arvexa-performance-overlay' ), __( 'Performance', 'arvexa-performance-overlay' ), 'manage_options', 'arvexa-performance-overlay', array( $this, 'render_settings_page' ), 'dashicons-performance', 80 );
	}

	private function core_status() {
		global $wp_version;
		$updates = get_site_transient( 'update_core' );
		$latest = '';
		$update = false;
		if ( is_object( $updates ) && ! empty( $updates->updates ) && is_array( $updates->updates ) ) {
			foreach ( $updates->updates as $offer ) {
				if ( ! empty( $offer->version ) && 'upgrade' === $offer->response ) { $latest = (string) $offer->version; $update = true; break; }
			}
		}
		return array( 'current' => (string) $wp_version, 'latest' => $latest ? $latest : (string) $wp_version, 'update' => $update, 'url' => admin_url( 'update-core.php' ) );
	}

	public function render_settings_page() {
		if ( ! current_user_can( 'manage_options' ) ) { return; }
		$settings = self::settings();
		$core = $this->core_status();
		$psi_url = 'https://pagespeed.web.dev/analysis?url=' . rawurlencode( home_url( '/' ) );
		?>
		<div class="wrap arvexa-performance-settings">
			<h1><?php esc_html_e( 'Arvexa Performance', 'arvexa-performance-overlay' ); ?></h1>
			<p class="description"><?php esc_html_e( 'Live diagnostics for administrators. Pulse adds a compact visual dashboard and a wide diagnostic grid.', 'arvexa-performance-overlay' ); ?></p>
			<div class="arvexa-performance-cards">
				<div class="arvexa-performance-card"><span><?php esc_html_e( 'WordPress Core', 'arvexa-performance-overlay' ); ?></span><strong><?php echo esc_html( $core['current'] ); ?></strong><em class="<?php echo $core['update'] ? 'is-update' : 'is-current'; ?>"><?php echo esc_html( $core['update'] ? sprintf( __( 'Update %s available', 'arvexa-performance-overlay' ), $core['latest'] ) : __( 'Up to date', 'arvexa-performance-overlay' ) ); ?></em><a href="<?php echo esc_url( $core['url'] ); ?>"><?php esc_html_e( 'Check Core updates', 'arvexa-performance-overlay' ); ?></a></div>
				<div class="arvexa-performance-card arvexa-performance-card-pulse"><span><?php esc_html_e( 'Lab checks', 'arvexa-performance-overlay' ); ?></span><strong><?php esc_html_e( 'PageSpeed Insights', 'arvexa-performance-overlay' ); ?></strong><em><?php esc_html_e( 'Desktop and Mobile scores open in a new tab.', 'arvexa-performance-overlay' ); ?></em><a href="<?php echo esc_url( $psi_url ); ?>" target="_blank" rel="noopener noreferrer"><?php esc_html_e( 'Open PageSpeed', 'arvexa-performance-overlay' ); ?> ↗</a></div>
			</div>
			<form method="post" action="options.php" class="arvexa-performance-form">
				<?php settings_fields( 'arvexa_performance_overlay_settings' ); ?>
				<h2><?php esc_html_e( 'Overlay appearance', 'arvexa-performance-overlay' ); ?></h2>
				<table class="form-table" role="presentation"><tbody>
					<tr><th scope="row"><?php esc_html_e( 'Interface theme', 'arvexa-performance-overlay' ); ?></th><td><select name="<?php echo esc_attr( self::SETTINGS_OPTION ); ?>[theme]"><option value="classic" <?php selected( $settings['theme'], 'classic' ); ?>><?php esc_html_e( 'Classic', 'arvexa-performance-overlay' ); ?></option><option value="pulse" <?php selected( $settings['theme'], 'pulse' ); ?>><?php esc_html_e( 'Performance Pulse', 'arvexa-performance-overlay' ); ?></option></select><p class="description"><?php esc_html_e( 'Pulse uses the dark neon visual language and prioritises the four key live metrics.', 'arvexa-performance-overlay' ); ?></p></td></tr>
				</tbody></table>
				<?php submit_button(); ?>
			</form>
		</div>
		<style>.arvexa-performance-settings{max-width:1060px}.arvexa-performance-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:24px 0}.arvexa-performance-card{padding:22px;border:1px solid #dcdcde;border-radius:12px;background:#fff}.arvexa-performance-card-pulse{border-color:#b6ef33;background:linear-gradient(135deg,#071119,#10221a);color:#f6fff0}.arvexa-performance-card span,.arvexa-performance-card em{display:block}.arvexa-performance-card strong{display:block;font-size:24px;margin:8px 0}.arvexa-performance-card em{margin-bottom:14px;color:#646970;font-style:normal}.arvexa-performance-card-pulse em{color:#b9cab8}.arvexa-performance-card a{font-weight:600}.is-current{color:#16803c!important}.is-update{color:#b32d2e!important}.arvexa-performance-form{padding:6px 24px 20px;border:1px solid #dcdcde;border-radius:12px;background:#fff}@media(max-width:640px){.arvexa-performance-cards{grid-template-columns:1fr}}</style>
		<?php
	}}

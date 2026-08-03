<?php
/**
 * Cleanup on uninstall: drop stored samples and environment fingerprints.
 *
 * @package Arvexa_Performance_Overlay
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'arvexa_performance_overlay_samples' );
delete_option( 'arvexa_performance_overlay_envs' );

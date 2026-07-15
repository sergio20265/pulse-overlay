<?php
/**
 * Cleanup on uninstall: drop stored samples and environment fingerprints.
 *
 * @package Pulse_Overlay
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'pulse_overlay_samples' );
delete_option( 'pulse_overlay_envs' );

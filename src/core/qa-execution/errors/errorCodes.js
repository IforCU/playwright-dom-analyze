// Known error codes across the system.
export const ERROR_CODES = {
  TARGET_NOT_FOUND:    'target_not_found',
  TARGET_NOT_VISIBLE:  'target_not_visible',
  TIMEOUT:             'timeout',
  ASSERTION_FAILED:    'assertion_failed',
  NAVIGATION_BLOCKED:  'navigation_blocked',
  OUT_OF_SCOPE:        'out_of_scope',
  AUTH_REQUIRED:       'auth_required',
  CONTEXT_DESTROYED:   'context_destroyed',
  RENDER_UNSTABLE:     'render_unstable',
  MODAL_BLOCKED:       'modal_blocked',
  CAPTURE_FAILED:      'capture_failed',
  UNSUPPORTED_STEP:    'unsupported_step',
  UNSUPPORTED_MATCHER: 'unsupported_matcher',
};

export const ALL_KNOWN_CODES = Object.values(ERROR_CODES);

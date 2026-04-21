/**
 * core/qa/runtimeContext.js
 *
 * Manages runtime namespaces during QA scenario execution.
 *
 * Namespaces:
 *   data.*        – immutable scenario-level input (from scenario.data)
 *   credential.*  – runtime-injected credentials (never written to final report)
 *   captured.*    – values stored by capture steps or saveAs fields
 *   runtime.*     – internal engine state (e.g., pre-click snapshots)
 *
 * Variable interpolation:
 *   "${keyword}"           → resolves from data.* (backward compat)
 *   "${data.keyword}"      → explicit data namespace
 *   "${captured.keyName}"  → explicit captured namespace
 *   "${credential.user}"   → credential namespace (value used but not logged)
 */
export class RuntimeContext {
  constructor({ data = {}, credentials = {} } = {}) {
    // Immutable scenario input
    this._data = Object.freeze({ ...data });
    // Runtime-injected credentials — treated as sensitive
    this._credential = { ...credentials };
    // Values produced by capture steps
    this._captured = {};
    // Internal engine state (pre-click aria/text snapshots, etc.)
    this._runtime = {};
    // Track which keys are credential-sourced so we can redact them in reports
    this._sensitiveKeys = new Set(Object.keys(credentials));
  }

  // ── Interpolation ────────────────────────────────────────────────────────────

  /**
   * Interpolate all ${...} references in a string template.
   * Unknown references are left as-is.
   *
   * @param {string} template
   * @returns {string}
   */
  interpolate(template) {
    if (typeof template !== 'string') return template;
    return template.replace(/\$\{([^}]+)\}/g, (match, key) => {
      const val = this._resolve(key.trim());
      return val !== undefined && val !== null ? String(val) : match;
    });
  }

  _resolve(key) {
    if (key.startsWith('data.'))       return this._data[key.slice(5)];
    if (key.startsWith('credential.')) return this._credential[key.slice(11)];
    if (key.startsWith('captured.'))   return this._captured[key.slice(9)];
    if (key.startsWith('runtime.'))    return this._runtime[key.slice(8)];
    // Backward compatibility: bare key resolves from data.*
    if (key in this._data)             return this._data[key];
    return undefined;
  }

  // ── captured.* ──────────────────────────────────────────────────────────────

  getCaptured(key) {
    return this._captured[key];
  }

  setCaptured(key, value) {
    this._captured[key] = value;
  }

  hasCaptured(key) {
    return Object.prototype.hasOwnProperty.call(this._captured, key);
  }

  // ── runtime.* (internal engine use) ─────────────────────────────────────────

  getRuntime(key) {
    return this._runtime[key];
  }

  setRuntime(key, value) {
    this._runtime[key] = value;
  }

  // ── Serialization for reports ────────────────────────────────────────────────

  /**
   * Serialize captured values for inclusion in the run report.
   * screenshot kind values are replaced with a placeholder.
   */
  serializeCaptured() {
    const result = {};
    for (const [k, v] of Object.entries(this._captured)) {
      if (Buffer.isBuffer(v)) {
        result[k] = '<binary screenshot>';
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  /**
   * Returns the data namespace (safe to include in reports).
   */
  serializeData() {
    return { ...this._data };
  }
}

import { resolveTemplateValue } from './resolveTemplateValue.js';
import { CapturedStore }        from './capturedStore.js';

/**
 * Holds all runtime namespaces for one scenario execution.
 *
 * One instance is created per scenario and passed through every step.
 * The instance exposes:
 *   - interpolate()   → resolve ${...} templates
 *   - captured.*      → step-to-step memory
 *   - runtime.*       → internal engine slots (e.g. pre-click snapshots)
 */
export class RuntimeState {
  /**
   * @param {object} opts
   * @param {object} opts.data        – scenario.data (immutable)
   * @param {object} opts.credentials – injected at run time (never logged)
   */
  constructor({ data = {}, credentials = {} } = {}) {
    this._data       = Object.freeze({ ...data });
    this._credential = { ...credentials };
    this._captured   = new CapturedStore();
    this._runtime    = {};
  }

  // ── Template interpolation ──────────────────────────────────────────────────

  interpolate(template) {
    return resolveTemplateValue(template, {
      data:       this._data,
      captured:   this._captured.snapshot(),
      credential: this._credential,
      runtime:    this._runtime,
    });
  }

  // ── captured.* ──────────────────────────────────────────────────────────────

  getCaptured(key)        { return this._captured.get(key); }
  setCaptured(key, value) { this._captured.set(key, value); }
  hasCaptured(key)        { return this._captured.has(key); }

  // ── runtime.* – internal engine slots ──────────────────────────────────────

  getRuntime(key)         { return this._runtime[key]; }
  setRuntime(key, value)  { this._runtime[key] = value; }

  // ── Serialization for reports ───────────────────────────────────────────────

  serializeCaptured() { return this._captured.serialize(); }

  serializeData() {
    // Expose only data keys in reports; credentials are omitted intentionally.
    return { ...this._data };
  }
}

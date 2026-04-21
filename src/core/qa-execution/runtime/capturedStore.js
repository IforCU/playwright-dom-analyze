/**
 * In-memory key/value store for values captured during step execution.
 * Provides typed get/set and a safe serialization for reports
 * (binary screenshots are replaced with a placeholder string).
 */
export class CapturedStore {
  constructor() {
    this._store = {};
  }

  set(key, value) {
    this._store[key] = value;
  }

  get(key) {
    return this._store[key];
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this._store, key);
  }

  /** Returns a copy safe for JSON serialization. */
  serialize() {
    const out = {};
    for (const [k, v] of Object.entries(this._store)) {
      out[k] = Buffer.isBuffer(v) ? '<binary screenshot>' : v;
    }
    return out;
  }

  /** Snapshot of the raw store — for internal use only. */
  snapshot() {
    return { ...this._store };
  }
}

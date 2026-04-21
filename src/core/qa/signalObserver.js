/**
 * core/qa/signalObserver.js
 *
 * Sets up observation promises for expectedSignals BEFORE a step action executes,
 * then collects and evaluates results AFTER the action completes.
 *
 * Supported signal types (per qa-signal-registry.json):
 *   urlChanged           – required: page URL must change
 *   urlChangedOptional   – optional: page URL may change
 *   networkRequest       – optional: a matching request is issued (urlContains filter)
 *   domChanged           – required: DOM mutation must occur
 *   domChangedOptional   – optional: DOM mutation may occur
 *   scrollChanged        – optional: window.scrollY must change
 *   elementVisible       – optional: target element becomes visible
 *
 * Usage:
 *   const observer = new SignalObserver(page);
 *   await observer.setup(step.expectedSignals, urlBefore);
 *   await performAction();
 *   const results = await observer.collect();
 */
export class SignalObserver {
  /**
   * @param {import('playwright').Page} page
   */
  constructor(page) {
    this.page = page;
    this._observations = [];
  }

  /**
   * Register all observations. Must be called before the step action.
   *
   * @param {object[]} expectedSignals
   * @param {string}   urlBefore  – current URL before the action
   */
  async setup(expectedSignals = [], urlBefore = '') {
    this._observations = [];
    for (const signal of expectedSignals) {
      const obs = await this._setupOne(signal, urlBefore);
      this._observations.push(obs);
    }
  }

  async _setupOne(signal, urlBefore) {
    const type      = signal.type ?? '';
    const timeout   = signal.timeoutMs ?? this._defaultTimeout(type);
    const required  = !type.endsWith('Optional');

    const obs = { type, required, timeoutMs: timeout, promise: null };

    switch (type) {
      // ── URL change ─────────────────────────────────────────────────────────
      case 'urlChanged':
      case 'urlChangedOptional':
        obs.promise = this.page
          .waitForURL(url => url.href !== urlBefore, { timeout })
          .then(()  => ({ observed: true,  actual: this.page.url() }))
          .catch(() => ({ observed: false, reason: 'URL did not change within timeout' }));
        break;

      // ── Network request ────────────────────────────────────────────────────
      case 'networkRequest': {
        const filter = signal.urlContains
          ? req => req.url().includes(signal.urlContains)
          : () => true;
        obs.promise = this.page
          .waitForRequest(filter, { timeout })
          .then(req => ({ observed: true,  requestUrl: req.url() }))
          .catch(()  => ({ observed: false, reason: 'No matching network request within timeout' }));
        break;
      }

      // ── DOM change ─────────────────────────────────────────────────────────
      case 'domChanged':
      case 'domChangedOptional':
        obs.promise = this.page
          .evaluate((timeoutMs) => {
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                observer.disconnect();
                resolve(false);
              }, timeoutMs);

              const observer = new MutationObserver(() => {
                clearTimeout(timer);
                observer.disconnect();
                resolve(true);
              });

              observer.observe(document.body, {
                childList:     true,
                subtree:       true,
                attributes:    true,
                characterData: true,
              });
            });
          }, timeout)
          .then(changed => ({ observed: changed, reason: changed ? undefined : 'No DOM mutation observed' }))
          .catch(()      => ({ observed: false,  reason: 'DOM observation error' }));
        break;

      // ── Scroll change ──────────────────────────────────────────────────────
      case 'scrollChanged': {
        const scrollYBefore = await this.page.evaluate(() => window.scrollY).catch(() => 0);
        obs.promise = (async () => {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 150));
            const scrollY = await this.page.evaluate(() => window.scrollY).catch(() => scrollYBefore);
            if (scrollY !== scrollYBefore) {
              return { observed: true, scrollY };
            }
          }
          return { observed: false, reason: 'Scroll position did not change within timeout' };
        })();
        break;
      }

      // ── Element visible ────────────────────────────────────────────────────
      // This signal is evaluated after the action; we just track it as deferred.
      case 'elementVisible':
        obs.promise = Promise.resolve({ observed: null, deferred: true });
        break;

      default:
        obs.promise = Promise.resolve({ observed: null, unknown: true,
          reason: `Unknown signal type: ${type}` });
    }

    return obs;
  }

  /**
   * Await all observation promises and return structured results.
   * Required signals that were not observed cause a blocking failure.
   *
   * @returns {Promise<import('./types.js').SignalResult[]>}
   */
  async collect() {
    const results = [];
    for (const obs of this._observations) {
      const detail = await obs.promise;
      const passed = obs.required
        ? detail.observed === true
        : (detail.observed !== false); // null/true are both acceptable for optional

      results.push({
        type:     obs.type,
        required: obs.required,
        observed: detail.observed,
        passed,
        detail,
      });
    }
    return results;
  }

  _defaultTimeout(type) {
    switch (type) {
      case 'urlChanged':           return 7000;
      case 'urlChangedOptional':   return 3000;
      case 'networkRequest':       return 5000;
      case 'domChanged':           return 5000;
      case 'domChangedOptional':   return 3000;
      case 'scrollChanged':        return 3000;
      case 'elementVisible':       return 5000;
      default:                     return 3000;
    }
  }
}

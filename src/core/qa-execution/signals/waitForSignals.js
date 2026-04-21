import { observeUrlChanged }    from './observeUrlChanged.js';
import { observeDomChanged }    from './observeDomChanged.js';
import { observeNetworkRequest } from './observeNetworkRequest.js';
import { observeScrollChanged }  from './observeScrollChanged.js';

const DEFAULT_TIMEOUTS = {
  urlChanged:         8000,
  urlChangedOptional: 8000,
  domChanged:         5000,
  domChangedOptional: 5000,
  networkRequest:     8000,
  scrollChanged:      3000,
  elementVisible:     5000,
};

/**
 * Registers all signal observations BEFORE a step action runs,
 * then waits for their results AFTER the action completes.
 *
 * Usage:
 *   const observations = await setupSignals(page, step.expectedSignals, page.url());
 *   await runAction();
 *   const results = await collectSignals(observations);
 *
 * @param {import('playwright').Page} page
 * @param {object[]} expectedSignals
 * @param {string}   urlBefore
 * @returns {Promise<Array<{ type, required, promise }>>}
 */
export async function setupSignals(page, expectedSignals, urlBefore) {
  if (!expectedSignals?.length) return [];

  return Promise.all(
    expectedSignals.map(async signal => {
      const type     = signal.type ?? '';
      const timeout  = signal.timeoutMs ?? DEFAULT_TIMEOUTS[type] ?? 5000;
      const required = !type.endsWith('Optional') && signal.required !== false;

      return {
        type,
        required,
        promise: buildObservationPromise(page, signal, urlBefore, timeout),
      };
    }),
  );
}

/**
 * Awaits all pending signal promises and formats results.
 *
 * @param {Array<{ type, required, promise }>} observations
 * @returns {Promise<Array<{ type, required, observed, passed, detail }>>}
 */
export async function collectSignals(observations) {
  return Promise.all(
    observations.map(async ({ type, required, promise }) => {
      const detail  = await promise;
      const observed = detail?.observed ?? false;
      const passed   = !required || observed;
      return { type, required, observed, passed, detail };
    }),
  );
}

// ── Signal → observation function dispatch ───────────────────────────────────

function buildObservationPromise(page, signal, urlBefore, timeout) {
  const type = signal.type ?? '';

  switch (type) {
    case 'urlChanged':
    case 'urlChangedOptional':
      return observeUrlChanged(page, urlBefore, timeout);

    case 'domChanged':
    case 'domChangedOptional':
      return observeDomChanged(page, timeout);

    case 'networkRequest':
      return observeNetworkRequest(page, signal.urlContains ?? null, timeout);

    case 'scrollChanged':
      return observeScrollChanged(page, timeout);

    case 'elementVisible':
      // elementVisible is resolved opportunistically after the action;
      // we don't pre-register a promise — just report observed:true always.
      return Promise.resolve({ observed: true });

    default:
      return Promise.resolve({ observed: false, reason: `지원하지 않는 시그널 유형: ${type}` });
  }
}

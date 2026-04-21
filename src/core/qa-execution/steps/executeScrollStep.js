import { normalizePlaywrightError } from '../errors/normalizePlaywrightError.js';

const DIRECTION_MAP = {
  down:  [0,  1],
  up:    [0, -1],
  right: [1,  0],
  left:  [-1, 0],
};

export async function executeScrollStep(page, step, _state, _elementMap, _policy, _locator) {
  const { direction = 'down', pixels = 300 } = step.scroll ?? {};
  const [mx, my] = DIRECTION_MAP[direction] ?? [0, 1];
  try {
    await page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [mx * pixels, my * pixels]);
    return { status: 'passed', logs: [] };
  } catch (e) {
    const { code, message } = normalizePlaywrightError(e);
    return { status: 'failed', errorCode: code, error: message, logs: [message] };
  }
}

import { normalizePlaywrightError } from '../errors/normalizePlaywrightError.js';
import { ERROR_CODES }              from '../errors/errorCodes.js';
import { writeFile, mkdir }         from 'node:fs/promises';
import { join, dirname }            from 'node:path';



/**
 * Capture a value from the resolved element (or page) and store it in runtimeState.
 *
 * Supported kinds:
 *   text | innerText | textContent | value | attribute | aria |
 *   screenshot | url | scrollY | visible
 *
 * @param {object} ctx.outputDir  – per-scenario output directory; required for screenshot saves
 */
export async function executeCaptureStep(page, step, state, _elementMap, _policy, locator, ctx = {}) {
  const capture = step.capture ?? {};
  const kind    = capture.kind   ?? 'text';
  const saveAs  = capture.saveAs ?? step.saveAs;
  const timeout = step.timeoutMs ?? 10000;
  const outputDir = ctx.outputDir ?? null;

  if (!saveAs) {
    return { status: 'passed', logs: ['capture: no saveAs — value discarded'], capturedOutput: null };
  }

  try {
    const raw = await captureValue(page, locator, kind, capture, timeout);

    // Screenshots: save PNG to disk under outputDir (outputs/qa-runs/…), store path rather than raw bytes.
    // This prevents multi-MB Buffer arrays from bloating JSON result files.
    if (kind === 'screenshot' && Buffer.isBuffer(raw)) {
      const safeKey  = saveAs.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `capture-${safeKey}.png`;
      const filePath = outputDir ? join(outputDir, fileName) : null;
      let storedValue = '<screenshot buffer>'; // fallback if no outputDir
      if (filePath) {
        await mkdir(dirname(filePath), { recursive: true }).catch(() => {});
        await writeFile(filePath, raw);
        storedValue = filePath.replace(/\\/g, '/');
      }
      state.setCaptured(saveAs, storedValue);
      return {
        status: 'passed',
        logs: [filePath ? `screenshot saved → ${fileName}` : 'screenshot captured (no outputDir)'],
        capturedOutput: { saveAs, kind, value: storedValue },
        artifacts: filePath ? [{ type: 'screenshot', path: storedValue, label: `capture: ${saveAs}` }] : [],
      };
    }

    state.setCaptured(saveAs, raw);
    return { status: 'passed', logs: [], capturedOutput: { saveAs, kind, value: raw } };
  } catch (e) {
    const { code, message } = normalizePlaywrightError(e);
    return { status: 'failed', errorCode: code, error: message, logs: [message], capturedOutput: null };
  }
}

async function captureValue(page, locator, kind, capture, timeout) {
  switch (kind) {
    case 'url':       return page.url();
    case 'scrollY':   return page.evaluate(() => window.scrollY);
    case 'screenshot':
      if (!locator) return page.screenshot({ type: 'png' });
      return locator.screenshot({ timeout });

    case 'text':
    case 'textContent': {
      if (!locator) throw new Error(`capture kind "${kind}" requires a resolved element`);
      return ((await locator.textContent({ timeout })) ?? '').trim();
    }
    case 'innerText': {
      if (!locator) throw new Error(`capture kind "innerText" requires a resolved element`);
      return ((await locator.innerText({ timeout })) ?? '').trim();
    }
    case 'value': {
      if (!locator) throw new Error(`capture kind "value" requires a resolved element`);
      return locator.inputValue({ timeout });
    }
    case 'attribute': {
      if (!locator) throw new Error(`capture kind "attribute" requires a resolved element`);
      const attr = capture.attributeName;
      if (!attr) throw new Error(`capture kind "attribute" requires "attributeName"`);
      return locator.getAttribute(attr, { timeout });
    }
    case 'aria': {
      if (!locator) throw new Error(`capture kind "aria" requires a resolved element`);
      return locator.evaluate(el => ({
        pressed:  el.getAttribute('aria-pressed'),
        expanded: el.getAttribute('aria-expanded'),
        selected: el.getAttribute('aria-selected'),
        label:    el.getAttribute('aria-label'),
        checked:  el.getAttribute('aria-checked'),
      }));
    }
    case 'visible': {
      if (!locator) throw new Error(`capture kind "visible" requires a resolved element`);
      return locator.isVisible().catch(() => false);
    }
    default:
      throw new Error(`지원하지 않는 컨처 유형: "${kind}"`);
  }
}

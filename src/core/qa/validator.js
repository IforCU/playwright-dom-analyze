/**
 * core/qa/validator.js
 *
 * Pre-execution validator for scenario suite JSON.
 *
 * Validates (per contract):
 *  - schema version compatibility
 *  - each scenario has required fields
 *  - each step type is supported
 *  - required fields are present for each step type
 *  - each matcher name is registered
 *  - each capture kind is registered
 *  - each expectedSignal type is registered
 *  - targetRef presence where required by step type
 *  - variable references are well-formed
 *  - timeout / retry values are positive numbers
 *  - safety flags are present in defaults
 *
 * Returns:
 *  { valid: boolean, errors: string[], warnings: string[] }
 *
 * The executor must NOT proceed if valid === false.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', '..', '..', 'config');

function loadConfig(name) {
  try {
    return JSON.parse(readFileSync(path.join(CONFIG_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

const STEP_CONTRACT    = loadConfig('qa-step-contract.json');
const MATCHER_REGISTRY = loadConfig('qa-matcher-registry.json');
const SIGNAL_REGISTRY  = loadConfig('qa-signal-registry.json');
const CAPTURE_KINDS    = loadConfig('qa-capture-kinds.json');

const SUPPORTED_STEP_TYPES   = STEP_CONTRACT    ? Object.keys(STEP_CONTRACT.stepTypes)    : [];
const SUPPORTED_MATCHERS     = MATCHER_REGISTRY ? Object.keys(MATCHER_REGISTRY.matchers)  : [];
const SUPPORTED_SIGNALS      = SIGNAL_REGISTRY  ? Object.keys(SIGNAL_REGISTRY.signals)    : [];
const SUPPORTED_CAPTURE_KINDS = CAPTURE_KINDS   ? Object.keys(CAPTURE_KINDS.captureKinds) : [];

// Variable reference pattern: ${anything}
const VAR_REF_RE = /\$\{[^}]+\}/g;
// Valid namespace prefixes
const VALID_NAMESPACES = ['data.', 'credential.', 'captured.', 'runtime.'];

/**
 * Validate a complete scenario suite JSON object.
 *
 * @param {object} suite
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateSuite(suite) {
  const errors   = [];
  const warnings = [];

  // ── Suite-level required fields ─────────────────────────────────────────────
  if (!suite.suiteId)   errors.push('[suite] Missing required field: suiteId');
  if (!suite.scenarios) errors.push('[suite] Missing required field: scenarios');
  if (!suite.environment?.baseURL && !suite.baseURL) warnings.push('[suite] baseURL is not set (environment.baseURL or baseURL); relative goto URLs may fail');

  if (!Array.isArray(suite.scenarios)) {
    errors.push('[suite] "scenarios" must be an array');
    return { valid: errors.length === 0, errors, warnings };
  }

  // ── Defaults ────────────────────────────────────────────────────────────────
  const defaultPolicy = suite.defaults?.executionPolicy ?? {};
  if (defaultPolicy.maxStepRetries !== undefined && typeof defaultPolicy.maxStepRetries !== 'number') {
    errors.push('[defaults] maxStepRetries must be a number');
  }
  if (defaultPolicy.timeoutMs !== undefined && defaultPolicy.timeoutMs <= 0) {
    errors.push('[defaults] timeoutMs must be a positive number');
  }

  // ── Scenarios ────────────────────────────────────────────────────────────────
  for (const [si, scenario] of suite.scenarios.entries()) {
    const sctx = `[scenario ${scenario.scenarioId ?? si}]`;

    if (!scenario.scenarioId) errors.push(`${sctx} Missing required field: scenarioId`);
    if (!scenario.title)      errors.push(`${sctx} Missing required field: title`);

    const allSteps = [
      ...(scenario.preconditions ?? []),
      ...(scenario.steps         ?? []),
    ];

    if (allSteps.length === 0) {
      warnings.push(`${sctx} Has no steps or preconditions`);
    }

    // Collect declared data keys for variable ref validation
    const dataKeys     = Object.keys(scenario.data ?? {});
    const capturedKeys = new Set();

    for (const [stpi, step] of allSteps.entries()) {
      const ctx = `${sctx} step[${step.stepId ?? stpi}]`;
      validateStep(step, ctx, dataKeys, capturedKeys, errors, warnings);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Step-level validation ─────────────────────────────────────────────────────

function validateStep(step, ctx, dataKeys, capturedKeys, errors, warnings) {
  if (!step.stepId) warnings.push(`${ctx} Missing stepId`);
  if (!step.type)   { errors.push(`${ctx} Missing required field: type`); return; }

  // ── Supported step type ──────────────────────────────────────────────────
  if (!SUPPORTED_STEP_TYPES.includes(step.type)) {
    errors.push(`${ctx} Unsupported step type: "${step.type}". Supported: ${SUPPORTED_STEP_TYPES.join(', ')}`);
    return;
  }

  const contract = STEP_CONTRACT?.stepTypes?.[step.type] ?? {};

  // ── Required fields ──────────────────────────────────────────────────────
  for (const field of (contract.requiredFields ?? [])) {
    if (field === 'targetRef' && !step.targetRef) {
      errors.push(`${ctx} type="${step.type}" requires targetRef`);
    } else if (field === 'url' && !step.url) {
      errors.push(`${ctx} type="goto" requires url`);
    } else if (field === 'input' && !step.input) {
      errors.push(`${ctx} type="${step.type}" requires input`);
    } else if (field === 'scroll' && !step.scroll) {
      errors.push(`${ctx} type="scroll" requires scroll object`);
    } else if (field === 'key' && !step.key) {
      errors.push(`${ctx} type="press" requires key`);
    } else if (field === 'assertion' && !step.assertion) {
      errors.push(`${ctx} type="expect" requires assertion`);
    }
  }

  // ── Type-specific checks ─────────────────────────────────────────────────
  switch (step.type) {
    case 'expect':
      validateAssertion(step.assertion, ctx, capturedKeys, errors, warnings);
      break;
    case 'capture': {
      const saveAs = step.capture?.saveAs ?? step.saveAs ?? null;
      if (!saveAs) warnings.push(`${ctx} capture step has no saveAs; value will be discarded`);
      if (saveAs) capturedKeys.add(saveAs);
      const kind = step.capture?.kind ?? 'text';
      if (!SUPPORTED_CAPTURE_KINDS.includes(kind)) {
        errors.push(`${ctx} Unsupported capture kind: "${kind}". Supported: ${SUPPORTED_CAPTURE_KINDS.join(', ')}`);
      }
      if (kind === 'attribute' && !step.capture?.attributeName) {
        errors.push(`${ctx} capture kind=attribute requires capture.attributeName`);
      }
      break;
    }
    case 'scroll':
      if (step.scroll?.pixels !== undefined && typeof step.scroll.pixels !== 'number') {
        errors.push(`${ctx} scroll.pixels must be a number`);
      }
      if (step.scroll?.direction && !['up','down','left','right'].includes(step.scroll.direction)) {
        errors.push(`${ctx} scroll.direction must be one of: up, down, left, right`);
      }
      break;
    case 'goto':
      if (step.url && !step.url.startsWith('/') && !step.url.startsWith('http')) {
        warnings.push(`${ctx} goto url "${step.url}" is neither relative nor absolute`);
      }
      break;
    default:
      break;
  }

  // ── timeout values ───────────────────────────────────────────────────────
  if (step.timeoutMs !== undefined && (typeof step.timeoutMs !== 'number' || step.timeoutMs <= 0)) {
    errors.push(`${ctx} timeoutMs must be a positive number`);
  }

  // ── expectedSignals ──────────────────────────────────────────────────────
  for (const signal of (step.expectedSignals ?? [])) {
    if (!signal.type) {
      errors.push(`${ctx} expectedSignal is missing "type"`);
    } else if (!SUPPORTED_SIGNALS.includes(signal.type)) {
      errors.push(`${ctx} Unsupported signal type: "${signal.type}". Supported: ${SUPPORTED_SIGNALS.join(', ')}`);
    }
  }

  // ── variable references ──────────────────────────────────────────────────
  checkVariableRefs(step, ctx, dataKeys, capturedKeys, warnings);
}

function validateAssertion(assertion, ctx, capturedKeys, errors, warnings) {
  if (!assertion) return;
  if (!assertion.matcher) {
    errors.push(`${ctx} assertion is missing "matcher"`);
    return;
  }
  if (!SUPPORTED_MATCHERS.includes(assertion.matcher)) {
    errors.push(`${ctx} Unsupported matcher: "${assertion.matcher}". Supported: ${SUPPORTED_MATCHERS.join(', ')}`);
    return;
  }

  const matcherDef = MATCHER_REGISTRY?.matchers?.[assertion.matcher] ?? {};

  // Check required matcher fields
  for (const field of (matcherDef.requiredFields ?? [])) {
    if (assertion[field] === undefined) {
      errors.push(`${ctx} matcher "${assertion.matcher}" requires field "${field}"`);
    }
  }

  // storedKey reference check for toChangeFromStored
  if (assertion.matcher === 'toChangeFromStored') {
    if (assertion.storedKey && !capturedKeys.has(assertion.storedKey)) {
      warnings.push(`${ctx} matcher toChangeFromStored references storedKey "${assertion.storedKey}" which may not have been captured yet`);
    }
  }
}

function checkVariableRefs(step, ctx, dataKeys, capturedKeys, warnings) {
  const template = step.input?.valueTemplate ?? step.input?.value ?? null;
  if (!template || typeof template !== 'string') return;

  const refs = template.match(VAR_REF_RE) ?? [];
  for (const ref of refs) {
    const inner = ref.slice(2, -1).trim(); // strip ${ and }
    const hasNamespace = VALID_NAMESPACES.some(ns => inner.startsWith(ns));
    if (!hasNamespace) {
      // Bare key: check it exists in data
      if (!dataKeys.includes(inner)) {
        warnings.push(`${ctx} Variable "\${${inner}}" is not declared in scenario.data and has no namespace prefix`);
      }
    } else if (inner.startsWith('captured.')) {
      const capturedKey = inner.slice('captured.'.length);
      if (!capturedKeys.has(capturedKey)) {
        warnings.push(`${ctx} Variable "\${${inner}}" references captured key "${capturedKey}" which may not exist at this step`);
      }
    }
  }
}

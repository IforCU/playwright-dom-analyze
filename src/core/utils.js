/**
 * core/utils.js
 *
 * Shared helpers used across core modules.
 */

import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve project root from this file's location (src/core/ → src/ → project root)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ── Job ID ─────────────────────────────────────────────────────────────────

export function generateJobId() {
  // e.g. "2024-05-01T12-30-00-a1b2c3d4"
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${ts}-${randomUUID().slice(0, 8)}`;
}

// ── Output paths ───────────────────────────────────────────────────────────

/** Absolute path to outputs/<jobId>/ */
export function jobOutputDir(jobId) {
  return path.join(PROJECT_ROOT, 'outputs', jobId);
}

/** Portable (forward-slash) relative path for JSON storage */
export function toRelPath(...segments) {
  return path.join(...segments).replace(/\\/g, '/');
}

// ── Text helpers ───────────────────────────────────────────────────────────

export function truncateText(str, maxLen = 100) {
  if (!str) return '';
  const cleaned = str.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

// ── Async helpers ──────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

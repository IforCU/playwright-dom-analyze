#!/usr/bin/env node
/**
 * cleanOutputs.js
 *
 * Removes debug-only JSON artifacts from crawl output directories,
 * keeping only what is needed for QA scenario generation:
 *
 *   KEEP:
 *     final-report.json          — compact QA report (all QA data)
 *     baseline.png               — page screenshot
 *     baseline-annotated.png     — annotated screenshot
 *     trigger-results/trigger-N-after.png
 *     trigger-results/trigger-N-annotated.png
 *     graph-snapshot.json        — URL graph (at crawl root only)
 *     crawl-graph.json           — full crawl graph
 *     crawl-graph.mmd            — Mermaid visualisation
 *
 *   REMOVE (debug/intermediate):
 *     static.json                — raw 589-7000+ node dump
 *     trigger-candidates.json    — raw trigger candidates
 *     next-queue.json            — duplicate of nextCandidates in report
 *     annotation-legend.json     — visual annotation legend
 *     frame-summary.json         — iframe diagnostics
 *     initial-stabilization.json — SPA stabilisation trace
 *     render-readiness.json      — render readiness metrics
 *     visibility-debug.json      — aria-hidden mismatch debug
 *     auto-dynamic-regions.json  — dynamic region observation
 *     graph-snapshot.json (per-page) — duplicate of crawl-root graph
 *     trigger-results/trigger-N.json          — raw trigger data
 *     trigger-results/trigger-N-diff-debug.json — DOM diff debug
 *     trigger-results/trigger-N-before.png      — before screenshots
 *
 * Usage:
 *   node src/scripts/cleanOutputs.js [outputDir...]
 *
 * Examples:
 *   node src/scripts/cleanOutputs.js outputs/2026-04-21T01-01-13-18a58e97
 *   node src/scripts/cleanOutputs.js outputs/*
 *   node src/scripts/cleanOutputs.js          # cleans ALL ./outputs/* dirs
 */

import fs   from 'node:fs/promises';
import path from 'node:path';

// ── Files to delete at the PAGE level (pages/pNNN_*/...) ────────────────────

/** Exact filenames to remove from each page directory */
const PAGE_LEVEL_DELETE = new Set([
  'static.json',
  'trigger-candidates.json',
  'next-queue.json',
  'annotation-legend.json',
  'frame-summary.json',
  'initial-stabilization.json',
  'render-readiness.json',
  'visibility-debug.json',
  'auto-dynamic-regions.json',
  'graph-snapshot.json',      // per-page only — crawl-root version is kept
  'filtered-node-debug.json',
  'label-filter-debug.json',
]);

/** Patterns to remove inside trigger-results/ subdirectory */
const TRIGGER_DELETE_SUFFIXES = [
  '-diff-debug.json',
  '-before.png',
];

/** Exact filenames to remove from trigger-results/ (no suffix logic needed) */
const TRIGGER_EXACT_DELETE = new Set([
  // trigger-N.json files — matched by regex below
]);

// ─────────────────────────────────────────────────────────────────────────────

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Remove a single file, logging the action.
 * @returns {number} bytes freed (0 if file not found)
 */
async function removeFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    await fs.unlink(filePath);
    console.log(`  del ${path.relative(process.cwd(), filePath)} (${(stat.size / 1024).toFixed(1)} KB)`);
    return stat.size;
  } catch {
    return 0; // already gone or permission error
  }
}

/**
 * Clean debug artifacts from a single page directory.
 * @param {string} pageDir  absolute path to pages/pNNN_xxx/
 * @returns {{ removed: number, freedBytes: number }}
 */
async function cleanPageDir(pageDir) {
  let removed = 0;
  let freedBytes = 0;

  // 1. Page-level files
  for (const name of PAGE_LEVEL_DELETE) {
    const target = path.join(pageDir, name);
    const freed = await removeFile(target);
    if (freed > 0) { removed++; freedBytes += freed; }
  }

  // 2. trigger-results/ directory
  const trigDir = path.join(pageDir, 'trigger-results');
  if (!await fileExists(trigDir)) return { removed, freedBytes };

  let entries;
  try {
    entries = await fs.readdir(trigDir);
  } catch {
    return { removed, freedBytes };
  }

  for (const entry of entries) {
    // Delete trigger-N.json (raw result files, not screenshots)
    if (/^trigger-\d+\.json$/.test(entry)) {
      const freed = await removeFile(path.join(trigDir, entry));
      if (freed > 0) { removed++; freedBytes += freed; }
      continue;
    }
    // Delete diff-debug and before-screenshots
    for (const suffix of TRIGGER_DELETE_SUFFIXES) {
      if (entry.endsWith(suffix)) {
        const freed = await removeFile(path.join(trigDir, entry));
        if (freed > 0) { removed++; freedBytes += freed; }
        break;
      }
    }
  }

  return { removed, freedBytes };
}

/**
 * Clean all page subdirectories inside a crawl output directory.
 * The crawl-level graph-snapshot.json and crawl-graph.* are kept.
 * @param {string} crawlDir  e.g. outputs/2026-04-21T01-01-13-18a58e97
 */
async function cleanCrawlDir(crawlDir) {
  const pagesDir = path.join(crawlDir, 'pages');
  if (!await fileExists(pagesDir)) {
    console.log(`  (no pages/ subdirectory in ${crawlDir}, skipping)`);
    return;
  }

  let pageDirs;
  try {
    const entries = await fs.readdir(pagesDir, { withFileTypes: true });
    pageDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(pagesDir, e.name));
  } catch {
    console.error(`  Cannot read ${pagesDir}`);
    return;
  }

  let totalRemoved = 0;
  let totalFreedBytes = 0;

  for (const pd of pageDirs) {
    console.log(`\n  [page] ${path.relative(process.cwd(), pd)}`);
    const { removed, freedBytes } = await cleanPageDir(pd);
    totalRemoved   += removed;
    totalFreedBytes += freedBytes;
  }

  console.log(
    `\n  Summary for ${path.basename(crawlDir)}: ` +
    `${totalRemoved} file(s) removed, ` +
    `${(totalFreedBytes / 1024 / 1024).toFixed(1)} MB freed`
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  let targets = process.argv.slice(2);

  // Default: all subdirectories of ./outputs/
  if (targets.length === 0) {
    const outputsDir = path.join(process.cwd(), 'outputs');
    if (!await fileExists(outputsDir)) {
      console.error('No outputs/ directory found. Specify target directories explicitly.');
      process.exit(1);
    }
    const entries = await fs.readdir(outputsDir, { withFileTypes: true });
    targets = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(outputsDir, e.name));
  }

  if (targets.length === 0) {
    console.log('No output directories found. Nothing to clean.');
    return;
  }

  console.log(`Cleaning ${targets.length} output director${targets.length === 1 ? 'y' : 'ies'}…`);

  for (const target of targets) {
    const absTarget = path.isAbsolute(target)
      ? target
      : path.join(process.cwd(), target);
    console.log(`\n[crawl] ${absTarget}`);
    await cleanCrawlDir(absTarget);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('cleanOutputs error:', err.message);
  process.exit(1);
});

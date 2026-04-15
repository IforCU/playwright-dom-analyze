/**
 * routes/analyze.js
 *
 * POST /analyze — accepts originalUrl + requestUrl, orchestrates the
 * Analyze Worker pipeline and returns a structured job result.
 *
 * Security: validates URL format and restricts protocol to http/https
 * to prevent SSRF via file:// or other schemes.
 *
 * Request body:
 * {
 *   "originalUrl": "https://example.com",   // required — defines rootHost scope
 *   "requestUrl":  "https://example.com/about"  // optional — defaults to originalUrl
 * }
 *
 * Response shape:
 * {
 *   "jobId": "string",
 *   "status": "done | skipped | stopped",
 *   "originalUrl": "string",
 *   "requestUrl": "string",
 *   "rootHost": "string",
 *   "requestHost": "string",
 *   "currentPageStatus": "analyzed_new_page | skipped_existing_page |
 *                         stopped_out_of_scope | stopped_redirect_out_of_scope",
 *   "reason": "string",
 *   "outputPath": "string",
 *   "summary": { "phase1": {...}, "phase3": {...}, "graphUpdate": {...} }
 * }
 */

import { Router } from 'express';
import { runAnalysis }  from '../core/runAnalysis.js';
import { generateJobId } from '../core/utils.js';

const router = Router();

router.post('/analyze', async (req, res) => {
  const { originalUrl, requestUrl: requestUrlInput } = req.body ?? {};

  // ── Input validation — originalUrl ──────────────────────────────────────────
  // originalUrl is required. It defines the root exploration scope (rootHost).

  if (!originalUrl || typeof originalUrl !== 'string') {
    return res.status(400).json({ error: '"originalUrl" field is required and must be a string' });
  }

  let parsedOriginal;
  try {
    parsedOriginal = new URL(originalUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid originalUrl format' });
  }

  if (!['http:', 'https:'].includes(parsedOriginal.protocol)) {
    return res.status(400).json({ error: 'Only http and https originalUrls are supported' });
  }

  // ── Input validation — requestUrl ────────────────────────────────────────────
  // requestUrl is the page to analyze in this execution.
  // If omitted, it defaults to originalUrl (first-time root exploration).

  const requestUrl = requestUrlInput ?? originalUrl;

  if (typeof requestUrl !== 'string') {
    return res.status(400).json({ error: '"requestUrl" must be a string if provided' });
  }

  let parsedRequest;
  try {
    parsedRequest = new URL(requestUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid requestUrl format' });
  }

  if (!['http:', 'https:'].includes(parsedRequest.protocol)) {
    return res.status(400).json({ error: 'Only http and https requestUrls are supported' });
  }

  // ── Run analysis ───────────────────────────────────────────────────────────

  const jobId = generateJobId();

  console.log('\n[analyze] ──────────────────────────────────');
  console.log(`[analyze] JOB        : ${jobId}`);
  console.log(`[analyze] originalUrl: ${originalUrl}`);
  console.log(`[analyze] requestUrl : ${requestUrl}`);
  console.log('[analyze] ──────────────────────────────────');

  try {
    const result = await runAnalysis({ jobId, originalUrl, requestUrl });

    // Map internal page status to HTTP response status label
    const statusLabel = {
      analyzed_new_page:             'done',
      skipped_existing_page:         'skipped',
      stopped_out_of_scope:          'stopped',
      stopped_redirect_out_of_scope: 'stopped',
    }[result.currentPageStatus] ?? 'done';

    return res.json({
      jobId,
      status:            statusLabel,
      originalUrl,
      requestUrl,
      rootHost:          result.rootHost,
      requestHost:       result.requestHost,
      currentPageStatus: result.currentPageStatus,
      reason:            result.reason ?? null,
      outputPath:        result.outputPath,
      summary:           result.summary,
    });
  } catch (err) {
    console.error(`[analyze] job ${jobId} failed:`, err.message);
    return res.status(500).json({ error: err.message, jobId });
  }
});

export default router;


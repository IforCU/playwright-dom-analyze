/**
 * routes/crawl.js
 *
 * POST /crawl — BFS multi-page crawl endpoint.
 *
 * Accepts a starting URL, optional crawl limits, and optional credentials,
 * then runs a full BFS exploration returning an aggregated final report.
 *
 * SECURITY NOTES
 * ──────────────
 * - originalUrl is validated for protocol (http/https only) to prevent SSRF.
 * - Credentials are validated for type but never echoed back in any response,
 *   log line, or output artifact (only host name and outcome are recorded).
 * - crawlOptions are bounded to prevent resource exhaustion (maxPages ≤ 200,
 *   maxDepth ≤ 20, maxParallelTriggers ≤ 8).
 *
 * Request body:
 * {
 *   "originalUrl": "https://example.com",          // required
 *   "credentials": {                                // optional
 *     "username": "user@example.com",
 *     "password": "secret"
 *   },
 *   "authHints": {                                  // optional
 *     "usernameSelector": "#email",
 *     "passwordSelector": "#password",
 *     "submitSelector":   "button[type=submit]",
 *     "postLoginSuccessUrlPattern": "/dashboard"
 *   },
 *   "crawlOptions": {                               // optional
 *     "maxPages":            20,   // default 20, max 200
 *     "maxDepth":            5,    // default 5,  max 20
 *     "maxParallelTriggers": 4     // default 4,  max 8
 *   }
 * }
 *
 * Response body:
 * {
 *   "jobId":        "string",
 *   "status":       "done",
 *   "outputPath":   "string",
 *   "crawlSummary": { ... },
 *   "pageCount":    number
 * }
 */

import { Router } from 'express';
import { runCrawl }      from '../core/qa-analysis/crawl/crawlRunner.js';
import { generateJobId } from '../core/qa-analysis/utils.js';

const router = Router();

router.post('/crawl', async (req, res) => {
  const { originalUrl, requestUrl: requestUrlInput, credentials, authHints, crawlOptions } = req.body ?? {};

  // ── Validate originalUrl ─────────────────────────────────────────────────────────
  if (!originalUrl || typeof originalUrl !== 'string') {
    return res.status(400).json({ error: '"originalUrl" is required and must be a string' });
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

  // ── Validate requestUrl (optional — BFS start point, defaults to originalUrl) ──────────
  let safeRequestUrl = null;
  if (requestUrlInput !== undefined && requestUrlInput !== null) {
    if (typeof requestUrlInput !== 'string') {
      return res.status(400).json({ error: '"requestUrl" must be a string' });
    }
    let parsedReq;
    try { parsedReq = new URL(requestUrlInput); } catch {
      return res.status(400).json({ error: 'Invalid requestUrl format' });
    }
    if (!['http:', 'https:'].includes(parsedReq.protocol)) {
      return res.status(400).json({ error: 'Only http and https requestUrls are supported' });
    }
    safeRequestUrl = requestUrlInput;
  }

  // ── Validate credentials (optional) ─────────────────────────────────────────
  // Credentials are accepted but NEVER echoed in any response or log.
  let safeCredentials = null;

  if (credentials !== undefined && credentials !== null) {
    if (typeof credentials !== 'object' || Array.isArray(credentials)) {
      return res.status(400).json({ error: '"credentials" must be an object' });
    }
    if (credentials.username !== undefined && typeof credentials.username !== 'string') {
      return res.status(400).json({ error: '"credentials.username" must be a string' });
    }
    if (credentials.password !== undefined && typeof credentials.password !== 'string') {
      return res.status(400).json({ error: '"credentials.password" must be a string' });
    }
    // Only forward credentials when both username and password are present
    if (credentials.username && credentials.password) {
      safeCredentials = { username: credentials.username, password: credentials.password };
    }
  }

  // ── Validate crawlOptions (optional) ────────────────────────────────────────
  // ── Validate authHints (optional) ───────────────────────────────────────────
  // CSS selectors / URL patterns to assist the generic login executor.
  // Values are accepted as-is (they are used as Playwright CSS selectors or
  // substring matches only, never eval'd or used in raw SQL or shell commands).
  let safeAuthHints = null;

  if (authHints !== undefined && authHints !== null) {
    if (typeof authHints !== 'object' || Array.isArray(authHints)) {
      return res.status(400).json({ error: '"authHints" must be an object' });
    }
    const {
      usernameSelector, passwordSelector, submitSelector,
      loginUrlPattern, postLoginSuccessUrlPattern,
    } = authHints;
    const strOrUndef = (v, name) => {
      if (v !== undefined && typeof v !== 'string') {
        throw new Error(`"authHints.${name}" must be a string`);
      }
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    try {
      safeAuthHints = {};
      const us = strOrUndef(usernameSelector,          'usernameSelector');
      const ps = strOrUndef(passwordSelector,          'passwordSelector');
      const ss = strOrUndef(submitSelector,            'submitSelector');
      const lp = strOrUndef(loginUrlPattern,           'loginUrlPattern');
      const sp = strOrUndef(postLoginSuccessUrlPattern,'postLoginSuccessUrlPattern');
      if (us) safeAuthHints.usernameSelector            = us;
      if (ps) safeAuthHints.passwordSelector            = ps;
      if (ss) safeAuthHints.submitSelector              = ss;
      if (lp) safeAuthHints.loginUrlPattern             = lp;
      if (sp) safeAuthHints.postLoginSuccessUrlPattern  = sp;
      if (!Object.keys(safeAuthHints).length) safeAuthHints = null;
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // ── Validate crawlOptions (optional) ────────────────────────────────────────
  let safeCrawlOptions = {};

  if (crawlOptions !== undefined && crawlOptions !== null) {
    if (typeof crawlOptions !== 'object' || Array.isArray(crawlOptions)) {
      return res.status(400).json({ error: '"crawlOptions" must be an object' });
    }

    const { maxPages, maxDepth, maxParallelPages, maxParallelTriggers } = crawlOptions;

    if (maxPages !== undefined) {
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) {
        return res.status(400).json({ error: '"crawlOptions.maxPages" must be an integer between 1 and 200' });
      }
      safeCrawlOptions.maxPages = maxPages;
    }

    if (maxDepth !== undefined) {
      if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 20) {
        return res.status(400).json({ error: '"crawlOptions.maxDepth" must be an integer between 0 and 20' });
      }
      safeCrawlOptions.maxDepth = maxDepth;
    }

    if (maxParallelPages !== undefined) {
      if (!Number.isInteger(maxParallelPages) || maxParallelPages < 1 || maxParallelPages > 8) {
        return res.status(400).json({ error: '"crawlOptions.maxParallelPages" must be an integer between 1 and 8' });
      }
      safeCrawlOptions.maxParallelPages = maxParallelPages;
    }

    if (maxParallelTriggers !== undefined) {
      if (!Number.isInteger(maxParallelTriggers) || maxParallelTriggers < 1 || maxParallelTriggers > 8) {
        return res.status(400).json({ error: '"crawlOptions.maxParallelTriggers" must be an integer between 1 and 8' });
      }
      safeCrawlOptions.maxParallelTriggers = maxParallelTriggers;
    }
  }

  // ── Run crawl ────────────────────────────────────────────────────────────────
  const jobId = generateJobId();

  console.log('\n[crawl-route] ──────────────────────────────────');
  console.log(`[crawl-route] JOB        : ${jobId}`);
  console.log(`[crawl-route] originalUrl: ${originalUrl}`);
  if (safeRequestUrl) console.log(`[crawl-route] requestUrl : ${safeRequestUrl}`);
  console.log(`[crawl-route] maxPages   : ${safeCrawlOptions.maxPages ?? 20}`);
  console.log(`[crawl-route] maxDepth   : ${safeCrawlOptions.maxDepth ?? 5}`);
  console.log(`[crawl-route] parallelPg : ${safeCrawlOptions.maxParallelPages ?? 1}`);
  console.log(`[crawl-route] auth       : ${safeCredentials ? 'credentials provided' : 'none'}`);
  if (safeAuthHints) console.log('[crawl-route] authHints  : provided');
  console.log('[crawl-route] ──────────────────────────────────');

  try {
    const crawlResult = await runCrawl({
      jobId,
      originalUrl,
      requestUrl:    safeRequestUrl,
      crawlOptions:  safeCrawlOptions,
      credentials:   safeCredentials,
      authHints:     safeAuthHints,
    });

    const {
      crawlSummary, pages, durationMs, graphVisualization,
      preAuthRequired, preAuthAttempted, preAuthSucceeded, preAuthFailed,
      preAuthReason, authenticatedSessionEstablished, crawlStartedAfterAuth,
    } = crawlResult.finalReport;

    return res.json({
      jobId,
      status:             'done',
      outputPath:         crawlResult.outputPath,
      stopReason:         crawlResult.finalReport.stopReason,
      crawlSummary,
      pageCount:          pages.length,
      durationMs:         durationMs ?? null,
      graphVisualization: graphVisualization ?? null,
      preAuth: {
        required:                    preAuthRequired,
        attempted:                   preAuthAttempted,
        succeeded:                   preAuthSucceeded,
        failed:                      preAuthFailed,
        reason:                      preAuthReason,
        authenticatedSessionEstablished,
        crawlStartedAfterAuth,
      },
    });

  } catch (err) {
    console.error(`[crawl-route] job ${jobId} failed:`, err.message);
    return res.status(500).json({ error: err.message, jobId });
  }
});

export default router;

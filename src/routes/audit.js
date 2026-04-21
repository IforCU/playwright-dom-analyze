/**
 * routes/audit.js
 *
 * POST /audit — Run analysis quality audit over previous outputs.
 *
 * Body (optional):
 *   { "applyTuning": false, "maxSamples": 20 }
 *
 * Response:
 *   { "status": "done", "totalJobsAudited": N, "outputPath": "...", "report": {...} }
 */

import express from 'express';
import { runAudit } from '../core/qa-analysis/audit/auditRunner.js';

const router = express.Router();

router.post('/audit', async (req, res) => {
  const applyTuning = req.body?.applyTuning === true;
  const maxSamples  = parseInt(req.body?.maxSamples ?? '20', 10);

  console.log(`[audit route] starting audit  applyTuning=${applyTuning}  maxSamples=${maxSamples}`);

  try {
    const report = await runAudit({ applyTuning, maxSamples });
    res.json({
      status:           'done',
      totalJobsAudited: report.totalJobsAudited,
      outputPath:       'outputs/audit/',
      report,
    });
  } catch (err) {
    console.error('[audit route] error:', err.message, err.stack);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

export default router;

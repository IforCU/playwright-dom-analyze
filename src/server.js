/**
 * server.js
 *
 * Entry point. Starts the Express HTTP server.
 * Keeps routing and middleware concerns separate from analysis logic.
 */

import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import analyzeRouter from './routes/analyze.js';
import auditRouter  from './routes/audit.js';
import crawlRouter  from './routes/crawl.js';
import qaRouter     from './routes/qa.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 3000;

// Parse incoming JSON request bodies
app.use(express.json());

// Serve the request UI from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve crawl output artifacts (graphs, screenshots) so crawl-graph.html
// can be opened directly from the browser at /outputs/{jobId}/crawl-graph.html
app.use('/outputs', express.static(path.join(__dirname, '..', 'outputs')));

// Mount routes
app.use('/', analyzeRouter);
app.use('/', auditRouter);
app.use('/', crawlRouter);
app.use('/', qaRouter);

const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] UI      → http://localhost:${PORT}/`);
  console.log(`[server] API     → POST http://localhost:${PORT}/analyze`);
  console.log(`[server] Crawl   → POST http://localhost:${PORT}/crawl`);
  console.log(`[server] Audit   → POST http://localhost:${PORT}/audit`);
  console.log(`[server] QA Run  → POST http://localhost:${PORT}/qa/run`);
  console.log(`[server] QA Val  → POST http://localhost:${PORT}/qa/validate`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use.`);
    console.error(`[server] Stop the existing process or set a different port:`);
    console.error(`[server]   PORT=3001 npm run dev`);
  } else {
    console.error('[server] Failed to start:', err.message);
  }
  process.exit(1);
});

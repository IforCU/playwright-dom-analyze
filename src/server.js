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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 3000;

// Parse incoming JSON request bodies
app.use(express.json());

// Serve the request UI from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// Mount routes
app.use('/', analyzeRouter);
app.use('/', auditRouter);

const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] UI      → http://localhost:${PORT}/`);
  console.log(`[server] API     → POST http://localhost:${PORT}/analyze`);
  console.log(`[server] Audit   → POST http://localhost:${PORT}/audit`);
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

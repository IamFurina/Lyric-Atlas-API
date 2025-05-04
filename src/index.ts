import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { searchLyrics, SearchResult } from './lyricService.js'; // Import the existing service

// --- Read External API URL from Environment Variable ---
const EXTERNAL_API_BASE_URL = process.env.EXTERNAL_NCM_API_URL;

// --- CHECK REQUIRED ENV VARS at startup (conceptual) ---
if (!EXTERNAL_API_BASE_URL) {
  console.error("FATAL ERROR: Required environment variable EXTERNAL_NCM_API_URL is not set.");
  // In a real app, you might throw an error or exit differently depending on context
  // For Vercel, functions might start anyway, so runtime checks are also good.
}

// --- Hono App Instance ---
const app = new Hono();

// --- Logger Shim (Matches BasicLogger in lyricService.ts) ---
// Simple logger adapter implementing the BasicLogger interface
const consoleLoggerShim = {
    info: (...args: any[]) => console.info(...args),
    warn: (...args: any[]) => console.warn(...args),
    error: (...args: any[]) => console.error(...args),
    // Optional debug, map to console.debug or console.log
    debug: (...args: any[]) => console.debug ? console.debug(...args) : console.log('[DEBUG]', ...args),
    // Add other methods if BasicLogger requires them, otherwise they are implicitly undefined
};

// --- CORS Middleware ---
// Configure CORS using Hono's built-in middleware
// Match the settings previously in vercel.json
app.use('/api/*', cors({
  origin: '*', // Or specify allowed origins: ['https://example.com']
  allowMethods: ['GET', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400,
  credentials: true,
}));

// --- API Endpoint: /api/search ---
app.get('/api/search', async (c) => {
  const id = c.req.query('id');
  const fallbackQuery = c.req.query('fallback');
  const fixedVersionRaw = c.req.query('fixedVersion');

  // Re-check required env var at runtime as well
  if (!EXTERNAL_API_BASE_URL) {
      console.error("RUNTIME ERROR: EXTERNAL_NCM_API_URL is not set.");
      c.status(500);
      return c.json({ found: false, id, error: 'Server configuration error.' });
  }

  if (!id) {
    c.status(400);
    return c.json({ found: false, error: 'Missing id parameter' });
  }

  console.log(`Hono API: Received request for ID: ${id}, fixed: ${fixedVersionRaw}, fallback: ${fallbackQuery}`);

  try {
    // Call the lyric service, passing the shim logger
    const result: SearchResult = await searchLyrics(id, {
      fixedVersion: fixedVersionRaw,
      fallback: fallbackQuery,
      logger: consoleLoggerShim // Pass the shim logger
    });

    if (result.found) {
      console.log(`Hono API: Found lyrics for ID: ${id}, Format: ${result.format}, Source: ${result.source}`);
      // 同时返回翻译歌词（如果有）
      if (result.translation) {
        console.log(`Hono API: Translation lyrics also found and included in response.`);
      }
      // 记录罗马音歌词
      if (result.romaji) {
        console.log(`Hono API: Romaji lyrics also found and included in response.`);
      }
      return c.json(result);
    } else {
      const statusCode = result.statusCode || 404;
      console.log(`Hono API: Lyrics not found or error for ID: ${id}. Status: ${statusCode}, Error: ${result.error}`);
      // Directly use the number; Hono status accepts number for valid codes
      c.status(statusCode as any); // Use 'as any' for quick fix if TS complains, or ensure statusCode is a valid number type Hono accepts
      return c.json(result);
    }

  } catch (error) {
    console.error({ msg: `Unexpected error during API handler execution for ID: ${id}`, error });
    const errorMessage = error instanceof Error ? error.message : 'Unknown processing error';
    c.status(500);
    return c.json({ found: false, id, error: `Failed to process lyric request: ${errorMessage}` });
  }
});

// --- Vercel Export ---
// Use the adapter for Vercel Node.js runtime as suggested by Hono docs for non-edge cases
import { handle } from '@hono/node-server/vercel';

export default handle(app);

// --- Local Development Startup (Uses @hono/node-server directly) ---

import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net'; // Import AddressInfo

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  console.log(`Using external API URL: ${EXTERNAL_API_BASE_URL}`);
  const port = parseInt(process.env.PORT || '3000', 10);

  const server = serve({
    fetch: app.fetch,
    port: port
  }, (info: AddressInfo) => { // Add info parameter with type
    console.log(`Server is running on http://localhost:${info.port}`); // Use info.port
  });

  // Optional: Add graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nGracefully shutting down...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });
}

import { Hono } from 'hono';
import type { Context } from 'hono';
import { handle } from 'hono/vercel';
import { cors } from 'hono/cors';
import { LyricProvider, type SearchResult } from './lyricService';
import { getLogger } from './utils';
import { prettyJSON } from 'hono/pretty-json'

// Create a logger instance for the API entrypoint
const apiLogger = getLogger('API');

export const config = {
  runtime: 'edge'
}

// --- App Setup ---
// Remove the Env type parameter from Hono
const app = new Hono().basePath('/api');

// --- CORS Middleware ---
app.use('*', cors({
  origin: '*', // Configure as needed for production
  allowMethods: ['GET', 'OPTIONS'],
}));

app.use('*', prettyJSON());


// --- Helper to get Env Vars and check ---
// Remove Context type hint related to Env
// Access environment variable directly using process.env
function getExternalApiBaseUrl(): string | undefined {
  // Read directly from process.env provided by Vercel Edge environment
  const url = process?.env?.EXTERNAL_NCM_API_URL;

  if (!url) {
    // Log only once if missing, maybe using a flag or a more robust config check
    apiLogger.error('Server configuration error: EXTERNAL_NCM_API_URL is not set in Vercel environment.');
  }
  return url;
}

// --- Routes ---

app.get('/', (c) => {
  apiLogger.info('Root endpoint accessed.'); // Use apiLogger
  return c.json({ message: 'Lyric Atlas API is running.' }); // Updated message
});

// Search route using LyricProvider
// Remove Context type hint related to Env
app.get('/search', async (c: Context) => {
  const id = c.req.query('id');
  const fallbackQuery = c.req.query('fallback');
  const fixedVersionRaw = c.req.query('fixedVersion');

  apiLogger.info(`Search request - ID: ${id}, Fixed: ${fixedVersionRaw}, Fallback: ${fallbackQuery}`);

  // Call the updated helper function
  const externalApiBaseUrl = getExternalApiBaseUrl(); // No need to pass 'c'

  if (!externalApiBaseUrl) {
    // Already logged in getExternalApiBaseUrl
    c.status(500);
    return c.json({ found: false, id, error: 'Server configuration error.' });
  }

  if (!id) {
    apiLogger.warn('Search failed: Missing id parameter.');
    c.status(400);
    return c.json({ found: false, error: 'Missing id parameter' });
  }

  try {
    // Instantiate LyricProvider within the request
    const lyricProvider = new LyricProvider(externalApiBaseUrl);

    const result: SearchResult = await lyricProvider.search(id, {
      fixedVersion: fixedVersionRaw,
      fallback: fallbackQuery,
    });

    if (result.found) {
      apiLogger.info(`Lyrics found for ID: ${id} - Format: ${result.format}, Source: ${result.source}`);
      if (result.translation) apiLogger.debug(`Translation found for ID: ${id}`);
      if (result.romaji) apiLogger.debug(`Romaji found for ID: ${id}`);
      return c.json(result);
    } else {
      const statusCode = result.statusCode || 404;
      // Type assertion needed because Hono expects specific literal types for status codes
      c.status(statusCode as any);
      apiLogger.info(`Lyrics not found for ID: ${id} - Status: ${statusCode}, Error: ${result.error}`);
      return c.json(result);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown processing error';
    apiLogger.error(`Unexpected error during search for ID: ${id} - ${errorMessage}`, error);
    c.status(500);
    return c.json({ found: false, id, error: `Failed to process lyric request: ${errorMessage}` });
  }
});

// --- Export for Vercel ---
export default handle(app)

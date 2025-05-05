import {
  LyricFormat,
  buildRawUrl,
  getLogger,
} from '../utils';
import type { FetchResult } from '../interfaces/lyricTypes';
import type { LyricFetcher } from '../interfaces/fetcher';

const logger = getLogger('RepositoryFetcher');

/**
 * Fetches lyrics from the GitHub repository.
 */
export class RepositoryFetcher implements LyricFetcher {
  async fetch(id: string, format: LyricFormat): Promise<FetchResult> {
    const url = buildRawUrl(id, format);
    logger.info(`Attempting fetch for ${format.toUpperCase()}: ${url}`);
    try {
      const response = await fetch(url);
      if (response.ok) {
        const content = await response.text();
        logger.info(`Success for ${format.toUpperCase()} (status: ${response.status})`);
        return { status: 'found', format, content, source: 'repository' };
      } else if (response.status === 404) {
        logger.info(`404 for ${format.toUpperCase()}`);
        return { status: 'notfound', format };
      } else {
        logger.error(`Failed for ${format.toUpperCase()} with HTTP status ${response.status}`);
        return { status: 'error', format, statusCode: response.status, error: new Error(`HTTP error ${response.status}`) };
      }
    } catch (err) {
      logger.error(`Network error for ${format.toUpperCase()}`, err);
      const error = err instanceof Error ? err : new Error('Unknown fetch error');
      return { status: 'error', format, error };
    }
  }
}

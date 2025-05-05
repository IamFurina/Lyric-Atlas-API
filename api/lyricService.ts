import {
  LyricFormat,
  DEFAULT_FALLBACK_ORDER,
  isValidFormat,
  getLogger,
} from './utils';
import { RepositoryFetcher } from './fetchers/repositoryFetcher';
import { ExternalApiFetcher } from './fetchers/externalApiFetcher';
import type { LyricFetcher, ExternalLyricFetcher } from './interfaces/fetcher';
import type { FetchResult, SearchResult, LyricProviderOptions } from './interfaces/lyricTypes';

// Get logger instance using our custom logger
const logger = getLogger('LyricService');

// Export SearchResult and LyricProviderOptions types for use in index.ts
export type { SearchResult, LyricProviderOptions };

// --- Lyric Provider Service ---

export class LyricProvider {
  private repoFetcher: LyricFetcher;
  private externalFetcher: ExternalLyricFetcher;

  constructor(externalApiBaseUrl: string | undefined) {
    this.repoFetcher = new RepositoryFetcher();
    this.externalFetcher = new ExternalApiFetcher(externalApiBaseUrl);
  }

  async search(id: string, options: LyricProviderOptions): Promise<SearchResult> {
    const { fixedVersion: fixedVersionRaw, fallback: fallbackQuery } = options;
    const fixedVersionQuery = fixedVersionRaw?.toLowerCase();
    logger.info(`LyricProvider: Processing ID: ${id}, fixed: ${fixedVersionQuery}, fallback: ${fallbackQuery}`);

    // 1. Handle fixedVersion if provided and valid
    if (isValidFormat(fixedVersionQuery)) {
      return this.handleFixedVersionSearch(id, fixedVersionQuery);
    }

    // --- Standard Search Flow (No valid fixedVersion) ---
    logger.info(`LyricProvider: Starting standard search flow.`);

    // 2. Start repository and external API checks in parallel
    logger.debug(`LyricProvider: Starting parallel checks for repository and external API.`);
    const repoPromise = this.findAllInRepo(id, fallbackQuery);
    const externalApiPromise = this.findInExternalApi(id);

    // Wait for both promises to settle
    const [repoResultSettled, externalApiResultSettled] = await Promise.allSettled([
      repoPromise,
      externalApiPromise
    ]);

    // 3. Prioritize Repository Result
    if (repoResultSettled.status === 'fulfilled' && repoResultSettled.value?.found) {
      logger.info('LyricProvider: Prioritizing result found in repository.');
      return repoResultSettled.value; // Found in repo, return immediately
    }

    // Log repository outcome if it didn't yield a usable result
    this.logRepoOutcome(repoResultSettled);

    // 4. Fallback to External API Result
    logger.info('LyricProvider: Repository check did not yield results, evaluating external API outcome.');
    if (externalApiResultSettled.status === 'fulfilled') {
      logger.info(`LyricProvider: External API check promise fulfilled, returning its result (found: ${externalApiResultSettled.value.found}).`);
      return externalApiResultSettled.value; // Return external result (found, notfound, or error)
    } else {
      // External API promise was rejected
      logger.error('LyricProvider: External API check promise was rejected.', externalApiResultSettled.reason);
      let repoErrorMsg = 'Repository check failed or found nothing.';
      if (repoResultSettled.status === 'fulfilled' && repoResultSettled.value && !repoResultSettled.value.found) {
        repoErrorMsg = `Repository check failed: ${repoResultSettled.value.error}`;
      }
      return {
        found: false,
        id,
        error: `Both repository and external API checks failed. Repo: ${repoErrorMsg} External API Error: ${externalApiResultSettled.reason?.message || 'Unknown rejection reason'}`,
        statusCode: 500
      };
    }
  }

  private async handleFixedVersionSearch(id: string, fixedVersionQuery: LyricFormat): Promise<SearchResult> {
    logger.info(`LyricProvider: Handling fixedVersion request for format: ${fixedVersionQuery}`);

    const repoResult = await this.repoFetcher.fetch(id, fixedVersionQuery);
    if (repoResult.status === 'found') {
      return { found: true, id, format: repoResult.format, source: 'repository', content: repoResult.content };
    }
    if (repoResult.status === 'error') {
      return { found: false, id, error: `Repo fetch failed for fixed format ${fixedVersionQuery}: ${repoResult.error.message}`, statusCode: repoResult.statusCode };
    }

    if (fixedVersionQuery === 'yrc' || fixedVersionQuery === 'lrc') {
      logger.info(`LyricProvider: Fixed ${fixedVersionQuery} not in repo, trying external.`);
      const externalResult = await this.externalFetcher.fetch(id, fixedVersionQuery);
      if (externalResult.status === 'found') {
        return {
          found: true,
          id,
          format: externalResult.format,
          source: 'external',
          content: externalResult.content,
          translation: externalResult.translation,
          romaji: externalResult.romaji
        };
      }
      if (externalResult.status === 'error') {
        return { found: false, id, error: `External fetch failed for fixed format ${fixedVersionQuery}: ${externalResult.error.message}`, statusCode: externalResult.statusCode };
      }
      logger.info(`LyricProvider: Fixed ${fixedVersionQuery} not found externally either.`);
    } else {
      logger.info(`LyricProvider: Fixed ${fixedVersionQuery} not in repo. External not checked for this format.`);
    }

    return { found: false, id, error: `Lyrics not found for fixed format: ${fixedVersionQuery}`, statusCode: 404 };
  }

  private async findAllInRepo(id: string, fallbackQuery: string | undefined): Promise<SearchResult | null> {
    let formatsToCheck: LyricFormat[] = ['ttml'];
    let specifiedFallbacks: LyricFormat[] = [];

    if (fallbackQuery) {
      specifiedFallbacks = fallbackQuery.split(',')
        .map((f: string) => f.trim().toLowerCase())
        .filter((f): f is LyricFormat => isValidFormat(f) && f !== 'ttml');
      if (specifiedFallbacks.length === 0 && fallbackQuery.split(',').length > 0) {
        logger.warn(`LyricProvider: Fallback query ("${fallbackQuery}") resulted in no valid non-TTML formats.`);
      }
      formatsToCheck.push(...specifiedFallbacks);
    } else {
      formatsToCheck.push(...DEFAULT_FALLBACK_ORDER.filter(f => f !== 'ttml'));
    }

    formatsToCheck = [...new Set(formatsToCheck)];

    if (formatsToCheck.length === 0) {
      logger.info(`LyricProvider: No valid repository formats to check.`);
      return null;
    }

    logger.debug(`LyricProvider: Fetching repository formats in parallel: ${formatsToCheck.join(', ')}`);
    const fetchPromises = formatsToCheck.map(format => this.repoFetcher.fetch(id, format));
    const results = await Promise.allSettled(fetchPromises);

    const resultMap = new Map<LyricFormat, FetchResult>();
    results.forEach((result, index) => {
      const format = formatsToCheck[index];
      if (result.status === 'fulfilled') {
        if (result.value.status === 'error') {
          logger.error(`LyricProvider: Error fetching repo format ${format.toUpperCase()} during parallel check: ${result.value.error.message}`, result.value.error);
        }
        resultMap.set(format, result.value);
      } else {
        logger.error(`LyricProvider: Promise rejected for repo format ${format.toUpperCase()}: ${result.reason}`, result.reason);
      }
    });

    for (const format of formatsToCheck) {
      const fetchResult = resultMap.get(format);
      if (fetchResult?.status === 'found') {
        logger.info(`LyricProvider: Found repository format ${format.toUpperCase()} via parallel fetch.`);
        return { found: true, id, format: fetchResult.format, source: 'repository', content: fetchResult.content };
      }
    }

    logger.info(`LyricProvider: Parallel repository fetches complete, no format found.`);
    return null;
  }

  private async findInExternalApi(id: string): Promise<SearchResult> {
    logger.info(`LyricProvider: Trying external API fallback.`);
    const externalResult = await this.externalFetcher.fetch(id, undefined);
    if (externalResult.status === 'found') {
      return {
        found: true,
        id,
        format: externalResult.format,
        source: 'external',
        content: externalResult.content,
        translation: externalResult.translation,
        romaji: externalResult.romaji
      };
    }
    if (externalResult.status === 'error') {
      return { found: false, id, error: `External API fallback failed: ${externalResult.error.message}`, statusCode: externalResult.statusCode };
    }
    logger.info(`LyricProvider: External API fallback did not yield usable lyrics.`);
    return { found: false, id, error: 'Lyrics not found in repository or external API', statusCode: 404 };
  }

  private logRepoOutcome(repoResultSettled: PromiseSettledResult<SearchResult | null>) {
    if (repoResultSettled.status === 'rejected') {
      logger.error('LyricProvider: Repository check promise was rejected.', repoResultSettled.reason);
    } else if (repoResultSettled.value === null) {
      logger.info('LyricProvider: Repository check found no applicable formats or lyrics.');
    } else if (!repoResultSettled.value.found) {
      logger.info(`LyricProvider: Repository check completed but found no lyrics (or encountered an error): ${repoResultSettled.value.error}`);
    }
    // If fulfilled and found, it was handled earlier.
  }
}

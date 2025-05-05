import {
  LyricFormat,
  buildExternalApiUrl,
  filterLyricLines,
  getLogger,
} from '../utils';
import type { FetchResult } from '../interfaces/lyricTypes';
import type { ExternalLyricFetcher } from '../interfaces/fetcher';

const logger = getLogger('ExternalApiFetcher');

/**
 * Fetches lyrics from the external API.
 */
export class ExternalApiFetcher implements ExternalLyricFetcher {
  constructor(private externalApiBaseUrl: string | undefined) {}

  async fetch(id: string, specificFormat?: 'yrc' | 'lrc'): Promise<FetchResult & { translation?: string; romaji?: string }> {
    if (!this.externalApiBaseUrl) {
      logger.error('Base URL not configured.');
      return { status: 'error', statusCode: 500, error: new Error('External API is not configured.') };
    }

    const externalUrl = buildExternalApiUrl(id, this.externalApiBaseUrl);
    logger.info(`Attempting fetch: ${externalUrl}`);

    try {
      const externalResponse = await fetch(externalUrl);
      if (!externalResponse.ok) {
        logger.error(`Failed with status: ${externalResponse.status} for URL: ${externalUrl}`);
        return { status: 'error', statusCode: 502, error: new Error(`External API failed with status ${externalResponse.status}`) };
      }

      let externalData: any;
      try {
        externalData = await externalResponse.json();
      } catch (parseError) {
        logger.error(`Failed to parse JSON for ID: ${id}`, parseError);
        return { status: 'error', statusCode: 502, error: new Error('External API returned invalid JSON.') };
      }

      const translationRaw = filterLyricLines(externalData?.tlyric?.lyric);
      const translation = translationRaw === null ? undefined : translationRaw;
      logger.debug(`Translation lyrics ${translation ? 'found' : 'not found'}.`);

      const romajiRaw = filterLyricLines(externalData?.romalrc?.lyric);
      const romaji = romajiRaw === null ? undefined : romajiRaw;
      logger.debug(`Romaji lyrics ${romaji ? 'found' : 'not found'}.`);

      let foundFormat: LyricFormat | undefined;
      let foundContent: string | undefined;

      const formatsToTry: (LyricFormat | undefined)[] = specificFormat
        ? [specificFormat]
        : ['yrc', 'lrc'];

      for (const format of formatsToTry) {
        if (!format) continue;
        const key = format === 'yrc' ? 'yrc' : 'lrc'; // Assuming API response keys match format names
        const filteredContent = filterLyricLines(externalData?.[key]?.lyric);
        if (filteredContent) {
          logger.info(`Found and filtered ${format.toUpperCase()} lyrics for ID: ${id}.`);
          foundFormat = format;
          foundContent = filteredContent;
          break; // Found the best available format
        }
      }

      if (foundFormat && foundContent) {
        return { status: 'found', format: foundFormat, source: 'external', content: foundContent, translation, romaji };
      }

      logger.info(`No usable lyrics${specificFormat ? ` for format ${specificFormat}` : ''} found for ID: ${id}.`);
      return { status: 'notfound', format: specificFormat };

    } catch (externalFetchError) {
      logger.error(`Network error during fetch for ID: ${id}`, externalFetchError);
      const error = externalFetchError instanceof Error ? externalFetchError : new Error('Unknown external fetch error');
      return { status: 'error', statusCode: 502, error };
    }
  }
}

// Define a simple logger interface
interface BasicLogger {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug?: (...args: any[]) => void; // Optional debug method
}

import {
  LyricFormat,
  buildRawUrl,
  buildExternalApiUrl,
  filterLyricLines,
  DEFAULT_FALLBACK_ORDER,
  isValidFormat
} from './utils';

// Define result types for internal fetch functions
export type FetchResult =
  | { status: 'found'; format: LyricFormat; content: string; source: 'repository' | 'external' }
  | { status: 'notfound'; format?: LyricFormat } // format might be unknown if initial external fetch failed
  | { status: 'error'; format?: LyricFormat; statusCode?: number; error: Error };

// Result type for the main search function
export type SearchResult =
  | { found: true; id: string; format: LyricFormat; source: 'repository' | 'external'; content: string; translation?: string; romaji?: string }
  | { found: false; id: string; error: string; statusCode?: number };

// Environment variable (should be passed in or handled differently in a real service)
const EXTERNAL_API_BASE_URL = process.env.EXTERNAL_NCM_API_URL;

// --- Internal Fetcher Functions ---

async function fetchRepoLyric(
  id: string,
  format: LyricFormat,
  logger: BasicLogger
): Promise<FetchResult> {
  const url = buildRawUrl(id, format);
  logger.info(`Attempting fetch from GitHub repo for ${format.toUpperCase()}: ${url}`);
  try {
    const response = await fetch(url);
    if (response.ok) {
      const content = await response.text();
      logger.info(`Repo fetch success for ${format.toUpperCase()} (status: ${response.status})`);
      return { status: 'found', format, content, source: 'repository' };
    } else if (response.status === 404) {
      logger.info(`Repo fetch resulted in 404 for ${format.toUpperCase()}`);
      return { status: 'notfound', format };
    } else {
      logger.error(`Repo fetch failed for ${format.toUpperCase()} with HTTP status ${response.status}`);
      return { status: 'error', format, statusCode: response.status, error: new Error(`HTTP error ${response.status}`) };
    }
  } catch (err) {
    logger.error(`Network error during repo fetch for ${format.toUpperCase()}`, err);
    const error = err instanceof Error ? err : new Error('Unknown fetch error');
    return { status: 'error', format, error };
  }
}

async function fetchExternalLyric(
  id: string,
  specificFormat: 'yrc' | 'lrc' | undefined, // Undefined means try both based on API response
  logger: BasicLogger
): Promise<FetchResult & { translation?: string; romaji?: string }> {
  const externalUrl = buildExternalApiUrl(id, EXTERNAL_API_BASE_URL);
  logger.info(`Attempting fetch from external API: ${externalUrl}`);

  try {
    const externalResponse = await fetch(externalUrl);
    if (!externalResponse.ok) {
      logger.error(`External API fetch failed with status: ${externalResponse.status} for URL: ${externalUrl}`);
      return { status: 'error', statusCode: 502, error: new Error(`External API failed with status ${externalResponse.status}`) };
    }

    let externalData;
    try {
      externalData = await externalResponse.json() as any;
    } catch (parseError) {
      logger.error(`Failed to parse JSON from external API fallback for ID: ${id}`, parseError);
      return { status: 'error', statusCode: 502, error: new Error('External API fallback returned invalid JSON.') };
    }

    // 获取翻译歌词，无论请求格式如何都尝试获取
    const translationRaw = filterLyricLines(externalData?.tlyric?.lyric);
    // 将 null 转换为 undefined 以符合类型要求
    const translation = translationRaw === null ? undefined : translationRaw;
    logger.info(`Translation lyrics ${translation ? 'found' : 'not found'} in external API response.`);

    // 获取罗马音歌词
    const romajiRaw = filterLyricLines(externalData?.romalrc?.lyric);
    const romaji = romajiRaw === null ? undefined : romajiRaw;
    logger.info(`Romaji lyrics ${romaji ? 'found' : 'not found'} in external API response.`);

    // Prioritize specific format if requested
    if (specificFormat === 'yrc') {
      const filteredContent = filterLyricLines(externalData?.yrc?.lyric);
      if (filteredContent) {
        logger.info(`Found and filtered YRC lyrics in external API for ID: ${id}.`);
        return { status: 'found', format: 'yrc', source: 'external', content: filteredContent, translation, romaji };
      }
    } else if (specificFormat === 'lrc') {
        const filteredContent = filterLyricLines(externalData?.lrc?.lyric);
        if (filteredContent) {
          logger.info(`Found and filtered LRC lyrics in external API for ID: ${id}.`);
          return { status: 'found', format: 'lrc', source: 'external', content: filteredContent, translation, romaji };
        }
    } else { // No specific format requested, try yrc then lrc
       const filteredYrc = filterLyricLines(externalData?.yrc?.lyric);
       if (filteredYrc) {
         logger.info(`Found and filtered YRC lyrics (default) in external API for ID: ${id}.`);
         return { status: 'found', format: 'yrc', source: 'external', content: filteredYrc, translation, romaji };
       }
       const filteredLrc = filterLyricLines(externalData?.lrc?.lyric);
       if (filteredLrc) {
         logger.info(`Found and filtered LRC lyrics (fallback) in external API for ID: ${id}.`);
         return { status: 'found', format: 'lrc', source: 'external', content: filteredLrc, translation, romaji };
       }
    }

    // If specific format requested but not found/filtered, or no format found
    logger.info(`No usable lyrics${specificFormat ? ` for format ${specificFormat}` : ''} found in external API response for ID: ${id}.`);
    return { status: 'notfound', format: specificFormat }; // Indicate not found for the specific/general case

  } catch (externalFetchError) {
    logger.error(`Network error during external API fallback fetch for ID: ${id}`, externalFetchError);
    const error = externalFetchError instanceof Error ? externalFetchError : new Error('Unknown external fetch error');
    return { status: 'error', statusCode: 502, error };
  }
}

// --- Helper functions for searchLyrics flow ---

async function handleFixedVersionSearch(
  id: string,
  fixedVersionQuery: LyricFormat, // Already validated
  logger: BasicLogger
): Promise<SearchResult> {
  logger.info(`LyricService: Handling fixedVersion request for format: ${fixedVersionQuery}`);

  // Try repository first
  const repoResult = await fetchRepoLyric(id, fixedVersionQuery, logger);
  if (repoResult.status === 'found') {
    return { found: true, id, format: repoResult.format, source: 'repository', content: repoResult.content };
  }
  if (repoResult.status === 'error') {
    return { found: false, id, error: `Repo fetch failed for fixed format ${fixedVersionQuery}: ${repoResult.error.message}`, statusCode: repoResult.statusCode };
  }

  // If repo not found, try external for yrc/lrc
  if (fixedVersionQuery === 'yrc' || fixedVersionQuery === 'lrc') {
    logger.info(`LyricService: Fixed ${fixedVersionQuery} not in repo, trying external.`);
    const externalResult = await fetchExternalLyric(id, fixedVersionQuery, logger);
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
    logger.info(`LyricService: Fixed ${fixedVersionQuery} not found externally either.`);
  } else {
    logger.info(`LyricService: Fixed ${fixedVersionQuery} not in repo. External not checked for this format.`);
  }

  // If fixedVersion was specified but not found after all checks
  return { found: false, id, error: `Lyrics not found for fixed format: ${fixedVersionQuery}`, statusCode: 404 };
}

async function findTtmlInRepo(
  id: string,
  logger: BasicLogger
): Promise<SearchResult | null> { // Returns SearchResult if found/error, null if notfound
  logger.info(`LyricService: Attempting TTML from repository.`);
  const ttmlResult = await fetchRepoLyric(id, 'ttml', logger);
  if (ttmlResult.status === 'found') {
    return { found: true, id, format: ttmlResult.format, source: 'repository', content: ttmlResult.content };
  }
  if (ttmlResult.status === 'error') {
    // If fetching primary format fails, return error immediately
    return { found: false, id, error: `Failed to fetch primary format TTML: ${ttmlResult.error.message}`, statusCode: ttmlResult.statusCode };
  }
  // TTML not found
  logger.info(`LyricService: TTML not found in repository.`);
  return null;
}

async function findInRepoFallbacks(
  id: string,
  fallbackQuery: string | undefined,
  logger: BasicLogger
): Promise<SearchResult | null> { // Returns SearchResult if found, null otherwise (errors logged)
  let fallbackOrder: LyricFormat[];
  if (fallbackQuery) {
    fallbackOrder = fallbackQuery.split(',')
      .map((f: string) => f.trim().toLowerCase())
      .filter((f): f is LyricFormat => isValidFormat(f) && f !== 'ttml');
    if (fallbackOrder.length === 0 && fallbackQuery.split(',').length > 0) {
      logger.warn(`LyricService: Fallback query ("${fallbackQuery}") resulted in no valid formats.`);
    }
  } else {
    fallbackOrder = DEFAULT_FALLBACK_ORDER;
  }

  if (fallbackOrder.length === 0) {
     logger.info(`LyricService: No valid repository fallback formats to check.`);
     return null;
  }

  logger.info(`LyricService: Fetching repository fallbacks in parallel: ${fallbackOrder.join(', ')}`);
  const fallbackPromises = fallbackOrder.map(format => fetchRepoLyric(id, format, logger));
  const fallbackResults = await Promise.allSettled(fallbackPromises);

  for (let i = 0; i < fallbackOrder.length; i++) {
    const format = fallbackOrder[i];
    const result = fallbackResults[i];
    if (result.status === 'fulfilled' && result.value.status === 'found') {
      logger.info(`LyricService: Found repo fallback ${format.toUpperCase()} via parallel fetch.`);
      return { found: true, id, format: result.value.format, source: 'repository', content: result.value.content };
    } else if (result.status === 'fulfilled' && result.value.status === 'error') {
      logger.error(`LyricService: Error fetching repo fallback ${format.toUpperCase()}: ${result.value.error.message}`, result.value.error);
    } else if (result.status === 'rejected') {
      logger.error(`LyricService: Promise rejected for repo fallback ${format.toUpperCase()}: ${result.reason}`, result.reason);
    }
    // 'notfound' status is logged within fetchRepoLyric or implicitly handled by loop continuing
  }

  logger.info(`LyricService: Parallel repository fallbacks complete, none found.`);
  return null; // None found
}

async function findInExternalApi(
  id: string,
  logger: BasicLogger
): Promise<SearchResult> { // Always returns a SearchResult (found, error, or final notfound)
  logger.info(`LyricService: Trying external API fallback.`);
  const externalResult = await fetchExternalLyric(id, undefined, logger); // undefined -> try yrc, then lrc
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

  // If externalResult.status is 'notfound'
  logger.info(`LyricService: External API fallback did not yield usable lyrics.`);
  return { found: false, id, error: 'Lyrics not found in repository or external API', statusCode: 404 };
}

// --- Main Search Function ---

export async function searchLyrics(
  id: string,
  options: {
    fixedVersion?: string;
    fallback?: string;
    logger: BasicLogger;
  }
): Promise<SearchResult> {

  const { fixedVersion: fixedVersionRaw, fallback: fallbackQuery, logger } = options;
  const fixedVersionQuery = fixedVersionRaw?.toLowerCase();
  logger.info(`LyricService: Processing ID: ${id}, fixed: ${fixedVersionQuery}, fallback: ${fallbackQuery}`);

  // 1. Handle fixedVersion if provided and valid
  if (isValidFormat(fixedVersionQuery)) {
    return handleFixedVersionSearch(id, fixedVersionQuery, logger);
  }

  // --- Standard Search Flow (No valid fixedVersion) ---
  logger.info(`LyricService: Starting standard search flow.`);

  // 2. Try TTML from repository
  const ttmlResult = await findTtmlInRepo(id, logger);
  if (ttmlResult) { // Returns SearchResult if found or error, null if not found
    return ttmlResult;
  }

  // 3. Try repository fallbacks (parallel)
  const repoFallbackResult = await findInRepoFallbacks(id, fallbackQuery, logger);
  if (repoFallbackResult) { // Returns SearchResult if found, null otherwise
    return repoFallbackResult;
  }

  // 4. Try External API fallback (always returns a SearchResult)
  return findInExternalApi(id, logger);
} 
// Logger factory that mimics log4js getLogger API
export function getLogger(category: string) {
  return {
    trace: (...args: any[]) => console.trace(`[TRACE][${category}]`, ...args),
    debug: (...args: any[]) => console.debug(`[DEBUG][${category}]`, ...args),
    info: (...args: any[]) => console.info(`[INFO][${category}]`, ...args),
    warn: (...args: any[]) => console.warn(`[WARN][${category}]`, ...args),
    error: (...args: any[]) => console.error(`[ERROR][${category}]`, ...args),
    fatal: (...args: any[]) => console.error(`[FATAL][${category}]`, ...args),
  };
}

// Create a logger instance specifically for utils functions
const utilsLogger = getLogger('Utils');

export type LyricFormat = 'ttml' | 'yrc' | 'lrc' | 'eslrc' | 'tlyric' | 'romalrc';

export const ALLOWED_FORMATS: LyricFormat[] = ['ttml', 'yrc', 'lrc', 'eslrc', 'tlyric', 'romalrc'];

// Default *fallback* order, excluding ttml initially
export const DEFAULT_FALLBACK_ORDER: LyricFormat[] = ['yrc', 'lrc', 'eslrc'];

export const isValidFormat = (format: string | undefined | null): format is LyricFormat => {
  if (!format) return false;
  return ALLOWED_FORMATS.includes(format as LyricFormat);
};

export const buildRawUrl = (id: string, format: LyricFormat): string => {
  const sanitizedId = encodeURIComponent(id);
  const baseUrl = 'https://raw.githubusercontent.com/Steve-XMH/amll-ttml-db/main/ncm-lyrics/';
  return `${baseUrl}${sanitizedId}.${format}`;
};

// buildExternalApiUrl now relies on EXTERNAL_API_BASE_URL being set externally
export const buildExternalApiUrl = (id: string, externalApiBaseUrl: string | undefined): string => {
  if (!externalApiBaseUrl) {
    // Log this error
    utilsLogger.error("External API base URL is not configured when building URL.");
    throw new Error("External API base URL is not configured.");
  }
  return `${externalApiBaseUrl}?id=${encodeURIComponent(id)}`;
}

// Define a regex to match typical LRC/YRC timestamp lines
export const LYRIC_LINE_REGEX = /^\[(?:\d{2}:\d{2}\.\d{2,3}|\d+,\d+)\]/;

// Helper function to extract valid lyric lines
export const filterLyricLines = (rawLyrics: string | undefined | null): string | null => {
  if (!rawLyrics) {
    return null;
  }
  const lines = rawLyrics.split('\n');
  const filteredLines = lines.filter(line => LYRIC_LINE_REGEX.test(line.trim()));
  return filteredLines.length > 0 ? filteredLines.join('\n') : null;
};

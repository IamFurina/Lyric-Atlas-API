import type { LyricFormat } from '../utils';
import type { FetchResult } from './lyricTypes';

// --- Fetcher Interface and Implementations ---

export interface LyricFetcher {
  fetch(id: string, format: LyricFormat): Promise<FetchResult>;
}

export interface ExternalLyricFetcher {
  fetch(id: string, specificFormat?: 'yrc' | 'lrc'): Promise<FetchResult & { translation?: string; romaji?: string }>;
}

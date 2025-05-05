import type { LyricFormat } from '../utils';

// Define result types for internal fetch functions
export type FetchResult =
  | { status: 'found'; format: LyricFormat; content: string; source: 'repository' | 'external' }
  | { status: 'notfound'; format?: LyricFormat } // format might be unknown if initial external fetch failed
  | { status: 'error'; format?: LyricFormat; statusCode?: number; error: Error };

// Result type for the main search function
export type SearchResult =
  | { found: true; id: string; format: LyricFormat; source: 'repository' | 'external'; content: string; translation?: string; romaji?: string }
  | { found: false; id: string; error: string; statusCode?: number };

// Options for the LyricProvider
export interface LyricProviderOptions {
  fixedVersion?: string;
  fallback?: string;
}

import {
  LyricFormat,
  buildRawUrl,
  buildExternalApiUrl,
  filterLyricLines,
  DEFAULT_FALLBACK_ORDER,
  isValidFormat,
  getLogger,
} from './utils';
import { RepositoryFetcher } from './fetchers/repositoryFetcher';
import { ExternalApiFetcher } from './fetchers/externalApiFetcher';
import type { LyricFetcher, ExternalLyricFetcher } from './interfaces/fetcher';
import type { FetchResult, LyricProviderOptions } from './interfaces/lyricTypes';
import { lyricsCache } from './cache';
import { fetchContent } from './httpClient';
import { checkMultipleFormatsWithWorker } from './workers';

// Get logger instance using our custom logger
const logger = getLogger('LyricService');

// Export SearchResult and LyricProviderOptions types for use in index.ts
export type { LyricProviderOptions };

// Result type for the main search function
export type SearchResult =
  | { found: true; id: string; format: LyricFormat; source: 'repository' | 'external'; content: string; translation?: string; romaji?: string }
  | { found: false; id: string; error: string; statusCode?: number };

// If BasicLogger is not imported or defined globally, define it here.
interface BasicLogger {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
}

// --- New types for metadata checking ---
export type LyricMetadataResult =
  | {
      found: true;
      id: string;
      availableFormats: LyricFormat[];
      hasTranslation?: boolean; // From external API
      hasRomaji?: boolean;      // From external API
    }
  | { found: false; id: string; error?: string; statusCode?: number };

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

    // 先检查缓存
    const cacheKey = `search:${id}:${fixedVersionQuery || 'none'}:${fallbackQuery || 'none'}`;
    const cachedResult = lyricsCache.get(cacheKey);
    if (cachedResult) {
      logger.info(`Cache hit for search with ID: ${id}, fixed: ${fixedVersionQuery}, fallback: ${fallbackQuery}`);
      return cachedResult;
    }

    // 检查固定版本
    if (isValidFormat(fixedVersionQuery)) {
      const result = await this.handleFixedVersionSearch(id, fixedVersionQuery);
      
      // 缓存结果
      if (result.found) {
        lyricsCache.set(cacheKey, result);
      }
      
      return result;
    }

    // --- 标准搜索流程 (TTML 优先) ---
    logger.info(`LyricProvider: Starting standard search flow. TTML from repo has highest priority.`);

    const TOTAL_TIMEOUT_MS = 6000; // 6秒总超时
    const controller = new AbortController();
    const overallTimeoutId = setTimeout(() => {
      logger.warn(`LyricProvider: Search timed out globally after ${TOTAL_TIMEOUT_MS}ms for ID: ${id}`);
      // 为 abort 方法提供一个 Error 对象作为 reason，这在后续的 Promise 拒绝处理中很有用
      controller.abort(new Error(`Search timed out after ${TOTAL_TIMEOUT_MS}ms`));
    }, TOTAL_TIMEOUT_MS);

    try {
      const repoTask = this.findAllInRepo(id, fallbackQuery);
      const externalApiTask = this.findInExternalApi(id);

      // 辅助函数，用于将任务与全局超时控制器竞速
      const raceWithGlobalTimeout = <T>(task: Promise<T>, taskName: string): Promise<T> => {
        return Promise.race([
          task,
          new Promise<T>((_, reject) => {
            if (controller.signal.aborted) { // 检查是否已经中止
              // 如果信号已经中止，立即拒绝，并使用信号的 reason
              return reject(controller.signal.reason || new Error(`${taskName} aborted due to pre-existing global timeout`));
            }
            // 监听 abort 事件
            controller.signal.addEventListener('abort', () => {
              reject(controller.signal.reason || new Error(`${taskName} aborted by global timeout`));
            });
        })
      ]);
      };

      const [repoResultSettled, externalApiResultSettled] = await Promise.allSettled([
        raceWithGlobalTimeout(repoTask, "Repository search"),
        raceWithGlobalTimeout(externalApiTask, "External API search")
      ]);

      clearTimeout(overallTimeoutId); // 所有操作已完成或被中止，清除总超时计时器

      let repoResultFromSettled: (SearchResult & { found: true }) | (SearchResult & { found: false }) | null = null;
      let externalResultFromSettled: (SearchResult & { found: true }) | (SearchResult & { found: false }) | null = null;

      // 处理仓库搜索结果
      if (repoResultSettled.status === 'fulfilled') {
        repoResultFromSettled = repoResultSettled.value;
      } else { // Rejected (被超时中止或内部错误)
        logger.warn(`LyricProvider: Repository search task failed or timed out: ${(repoResultSettled.reason as Error)?.message || String(repoResultSettled.reason)}`);
      }

      // 处理外部 API 搜索结果
      if (externalApiResultSettled.status === 'fulfilled') {
        externalResultFromSettled = externalApiResultSettled.value;
      } else { // Rejected
        logger.warn(`LyricProvider: External API search task failed or timed out: ${(externalApiResultSettled.reason as Error)?.message || String(externalApiResultSettled.reason)}`);
      }

      // --- 评估逻辑，TTML 具有最高优先级 ---

      // 1. 检查仓库结果中的 TTML (最高优先级)
      if (repoResultFromSettled?.found && repoResultFromSettled.format === 'ttml') {
        logger.info(`LyricProvider: TTML found in repository. Returning as highest priority.`);
        lyricsCache.set(cacheKey, repoResultFromSettled);
        return repoResultFromSettled;
      }

      // 2. 检查仓库结果中的任何其他歌词 (第二优先级)
      if (repoResultFromSettled?.found) { // 此处 repoResultFromSettled.format !== 'ttml'
        logger.info(`LyricProvider: Non-TTML lyrics found in repository (format: ${repoResultFromSettled.format}). Returning.`);
        lyricsCache.set(cacheKey, repoResultFromSettled);
        return repoResultFromSettled;
      }
      
      // 如果仓库没有成功返回结果，记录仓库的最终状态 (用于调试和错误诊断)
      // this.logRepoOutcome 需要一个 PromiseSettledResult<SearchResult | null> 类型的参数
      if (repoResultSettled.status === 'fulfilled') {
        this.logRepoOutcome(repoResultSettled as PromiseSettledResult<SearchResult | null>);
      } else { // status === 'rejected'
        // 对于 rejected Prmise，将其包装成符合 logRepoOutcome 期望的结构 (虽然它主要处理 fulfilled)
        this.logRepoOutcome(repoResultSettled as PromiseSettledResult<null>); 
      }

      // 3. 检查外部 API 的歌词 (第三优先级)
      if (externalResultFromSettled?.found) {
        logger.info(`LyricProvider: Lyrics found in external API (format: ${externalResultFromSettled.format}). Returning.`);
        lyricsCache.set(cacheKey, externalResultFromSettled);
        return externalResultFromSettled;
      }
      if (externalResultFromSettled && !externalResultFromSettled.found) {
        logger.info(`LyricProvider: External API check completed but found no lyrics (error: ${externalResultFromSettled.error}, status: ${externalResultFromSettled.statusCode}).`);
      }

      // 4. 如果所有来源都没有找到歌词，则确定并返回合并的错误信息
      let finalErrorMsg = "Lyrics not found after checking all sources.";
      let finalStatusCode: number = 404; // 默认状态码
      
      const errorsEncountered: string[] = [];
      let wasRepoSearchAttemptedAndFailed = true; // 假设尝试过且失败，除非找到证据
      let wasExternalSearchAttemptedAndFailed = true;

      if (repoResultSettled.status === 'fulfilled') {
        if (repoResultFromSettled && repoResultFromSettled.found) wasRepoSearchAttemptedAndFailed = false;
        else errorsEncountered.push(`Repo: ${repoResultFromSettled?.error || 'Not found or null result'}`);
        // 如果仓库返回了具体的错误码 (非404 "Not Found")，优先使用它
        if (repoResultFromSettled?.statusCode && repoResultFromSettled.statusCode !== 200 && repoResultFromSettled.statusCode !== 404) {
            finalStatusCode = repoResultFromSettled.statusCode;
        }
      } else { // 仓库搜索被拒绝 (例如超时或严重错误)
        errorsEncountered.push(`Repo Error: ${(repoResultSettled.reason as Error)?.message || String(repoResultSettled.reason)}`);
        // 如果是超时错误，状态码设为 408
        if (controller.signal.reason === repoResultSettled.reason || (repoResultSettled.reason as Error)?.name === 'AbortError' || String(repoResultSettled.reason).toLowerCase().includes('timeout')) {
            finalStatusCode = 408;
      } else {
            finalStatusCode = (repoResultSettled.reason as any)?.statusCode || 500; // 其他拒绝原因，尝试获取状态码或默认为500
        }
      }

      if (externalApiResultSettled.status === 'fulfilled') {
        if (externalResultFromSettled && externalResultFromSettled.found) wasExternalSearchAttemptedAndFailed = false;
        else errorsEncountered.push(`External API: ${externalResultFromSettled?.error || 'Not found or null result'}`);
        // 如果仓库也失败了，并且外部API有更具体的错误码 (例如服务器错误)，则考虑使用它
        if (wasRepoSearchAttemptedAndFailed && externalResultFromSettled?.statusCode && externalResultFromSettled.statusCode !== 200) {
          if (finalStatusCode === 404 || finalStatusCode === 408 || externalResultFromSettled.statusCode >= 500) {
            finalStatusCode = externalResultFromSettled.statusCode;
          }
        }
      } else { // 外部API搜索被拒绝
        errorsEncountered.push(`External API Error: ${(externalApiResultSettled.reason as Error)?.message || String(externalApiResultSettled.reason)}`);
        if (wasRepoSearchAttemptedAndFailed) { // 只有当仓库也失败时，才根据外部API的拒绝原因更新状态码
          if (controller.signal.reason === externalApiResultSettled.reason || (externalApiResultSettled.reason as Error)?.name === 'AbortError' || String(externalApiResultSettled.reason).toLowerCase().includes('timeout')) {
            if (finalStatusCode === 404) finalStatusCode = 408; // 超时优先于"未找到"
          } else {
            const externalRejectionStatusCode = (externalApiResultSettled.reason as any)?.statusCode;
            if (finalStatusCode === 404 || finalStatusCode === 408) finalStatusCode = externalRejectionStatusCode || 500;
          }
        }
      }
      
      if (wasRepoSearchAttemptedAndFailed && wasExternalSearchAttemptedAndFailed && errorsEncountered.length > 0) {
        finalErrorMsg = errorsEncountered.join('; ');
      } else if (controller.signal.aborted && controller.signal.reason instanceof Error && controller.signal.reason.message.startsWith("Search timed out")) {
        // 捕获总超时，如果之前的错误处理未能明确设定超时
        finalErrorMsg = controller.signal.reason.message;
        finalStatusCode = 408;
      }

      logger.info(`LyricProvider: Search concluded. Final error: "${finalErrorMsg}", status: ${finalStatusCode}`);
      const finalSearchResult: SearchResult = { found: false, id, error: finalErrorMsg, statusCode: finalStatusCode };
      // 错误结果不应被主搜索缓存键缓存，只有成功找到的才缓存
      return finalSearchResult;

    } catch (error) { // 捕获 search 方法编排逻辑中的意外错误
      clearTimeout(overallTimeoutId);
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`LyricProvider: Catastrophic error in search orchestrator: ${err.message}`, err);
      return {
        found: false,
        id,
        error: `Orchestrator error: ${err.message}`,
        statusCode: 500
      };
    }
  }

  private async handleFixedVersionSearch(id: string, fixedVersionQuery: LyricFormat): Promise<SearchResult> {
    logger.info(`LyricProvider: Handling fixedVersion request for format: ${fixedVersionQuery}`);
    
    const cacheKey = `fixed:${id}:${fixedVersionQuery}`;
    const cachedResult = lyricsCache.get(cacheKey);
    if (cachedResult) {
      logger.info(`Cache hit for fixed version search: ${id}, format: ${fixedVersionQuery}`);
      return cachedResult;
    }

    // 针对 yrc 和 lrc 格式，并行从仓库和外部API获取
    if (fixedVersionQuery === 'yrc' || fixedVersionQuery === 'lrc') {
      logger.info(`LyricProvider: Handling fixedVersion ${fixedVersionQuery} with parallel repo/external check.`);

      const repoPromise = this.repoFetcher.fetch(id, fixedVersionQuery);
      const externalPromise = this.externalFetcher.fetch(id, fixedVersionQuery);

      const [repoFetchResultSettled, externalFetchResultSettled] = await Promise.allSettled([
        repoPromise,
        externalPromise
      ]);

      // 优先仓库结果
      if (repoFetchResultSettled.status === 'fulfilled' && repoFetchResultSettled.value.status === 'found') {
        const repoFetchResult = repoFetchResultSettled.value;
        const result: SearchResult = { 
          found: true as const, 
          id, 
          format: repoFetchResult.format, 
          source: 'repository', 
          content: repoFetchResult.content 
        };
        lyricsCache.set(cacheKey, result);
        return result;
      }
      
      // 其次外部API结果
      if (externalFetchResultSettled.status === 'fulfilled' && externalFetchResultSettled.value.status === 'found') {
        const externalFetchResult = externalFetchResultSettled.value;
        const result: SearchResult = {
          found: true as const,
          id,
          format: externalFetchResult.format,
          source: 'external',
          content: externalFetchResult.content,
          translation: externalFetchResult.translation,
          romaji: externalFetchResult.romaji
        };
        lyricsCache.set(cacheKey, result);
        return result;
      }
      
      // 如果两者都未成功找到，处理错误
      let finalErrorMsg = `Lyrics not found for fixed format ${fixedVersionQuery}.`;
      let finalStatusCode: number | undefined = 404;

      const repoOutcome = repoFetchResultSettled.status === 'fulfilled' ? repoFetchResultSettled.value : null;
      const externalOutcome = externalFetchResultSettled.status === 'fulfilled' ? externalFetchResultSettled.value : null;

      const repoError = repoFetchResultSettled.status === 'rejected' 
        ? repoFetchResultSettled.reason 
        : (repoOutcome?.status === 'error' ? repoOutcome.error : null);
      const externalError = externalFetchResultSettled.status === 'rejected' 
        ? externalFetchResultSettled.reason 
        : (externalOutcome?.status === 'error' ? externalOutcome.error : null);

      const repoStatusCode = repoOutcome?.status === 'error' 
        ? repoOutcome.statusCode 
        : (repoFetchResultSettled.status === 'rejected' ? 500 : null);
      const externalStatusCode = externalOutcome?.status === 'error' 
        ? externalOutcome.statusCode 
        : (externalFetchResultSettled.status === 'rejected' ? 500 : null);
      
      const errors: string[] = [];
      if (repoError) {
        const message = repoError instanceof Error ? repoError.message : String(repoError);
        errors.push(`Repo: ${message}`);
      }
      if (externalError) {
        const message = externalError instanceof Error ? externalError.message : String(externalError);
        errors.push(`External: ${message}`);
      }

      if (errors.length > 0) {
        finalErrorMsg = `Failed to fetch fixed format ${fixedVersionQuery}: ${errors.join('; ')}`;
        // 优先服务器错误 (5xx)
        if (repoStatusCode && repoStatusCode >= 500) finalStatusCode = repoStatusCode;
        else if (externalStatusCode && externalStatusCode >= 500) finalStatusCode = externalStatusCode;
        else if (repoStatusCode) finalStatusCode = repoStatusCode; // 其他仓库错误码
        else if (externalStatusCode) finalStatusCode = externalStatusCode; // 其他外部API错误码
        else finalStatusCode = 500; // 如果没有具体错误码但有错误信息
      }
      
      return { found: false, id, error: finalErrorMsg, statusCode: finalStatusCode };

    } else { // 对于非 yrc/lrc 格式 (例如 ttml, qrc)，只检查仓库
      logger.info(`LyricProvider: Handling fixedVersion ${fixedVersionQuery} with repo-only check.`);
      try {
        const repoResult = await this.repoFetcher.fetch(id, fixedVersionQuery);
        if (repoResult.status === 'found') {
            const result: SearchResult = {
              found: true as const,
              id,
            format: repoResult.format, 
            source: 'repository', 
            content: repoResult.content 
            };
            lyricsCache.set(cacheKey, result);
            return result;
          }
          
        if (repoResult.status === 'error') {
            return { 
              found: false, 
              id, 
            error: `Repo fetch failed for fixed format ${fixedVersionQuery}: ${repoResult.error.message}`, 
            statusCode: repoResult.statusCode 
          };
        }
        // status === 'notfound'
      return { found: false, id, error: `Lyrics not found for fixed format: ${fixedVersionQuery}`, statusCode: 404 };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`LyricProvider: Unexpected error during repo-only fixed format search for ${fixedVersionQuery}: ${err.message}`);
      return { 
        found: false, 
        id, 
        error: `Unexpected error during search: ${err.message}`, 
        statusCode: 500 
      };
      }
    }
  }

  private async findAllInRepo(id: string, fallbackQuery: string | undefined): Promise<SearchResult | null> {
    // 确定要检查的格式
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

    // 尝试使用工作线程进行多格式检查
    try {
      // 先检查缓存中是否有任何格式的结果
      for (const format of formatsToCheck) {
        const cacheKey = `repo:${id}:${format}`;
        const cachedResult = lyricsCache.get(cacheKey);
        if (cachedResult && cachedResult.status === 'found') {
          logger.info(`LyricProvider: Cache hit for repository format ${format} during parallel check.`);
          return { 
            found: true as const, 
            id, 
            format: cachedResult.format, 
            source: 'repository', 
            content: cachedResult.content 
          };
        }
      }
      
      // 尝试使用工作线程进行批量检查
      try {
        const formatCheckResult = await checkMultipleFormatsWithWorker(id, formatsToCheck);
        
        if (formatCheckResult.availableFormats.length > 0) {
          let formatToFetch: LyricFormat | undefined = undefined;
          if (formatCheckResult.availableFormats.includes('ttml')) {
            formatToFetch = 'ttml';
            logger.info(`LyricProvider: Worker found TTML in repository, prioritizing it.`);
          } else if (formatCheckResult.availableFormats.length > 0) { // 确保列表不为空
            formatToFetch = formatCheckResult.availableFormats[0];
            logger.info(`LyricProvider: Worker found format ${formatToFetch.toUpperCase()} in repository (TTML not prioritized or not found by worker).`);
          }

          if (formatToFetch) {
          // 获取具体内容
            const fetchResult = await this.repoFetcher.fetch(id, formatToFetch);
          if (fetchResult.status === 'found') {
            return { 
              found: true as const, 
              id, 
              format: fetchResult.format, 
              source: 'repository', 
              content: fetchResult.content 
            };
            } else {
              logger.warn(`LyricProvider: Worker indicated ${formatToFetch} was available, but subsequent fetch failed or was not found.`);
            }
          }
        }
      } catch (workerError) {
        logger.warn(`LyricProvider: Worker-based check failed, falling back to direct fetch: ${workerError instanceof Error ? workerError.message : String(workerError)}`);
        // 继续使用传统的并行fetch方法
      }
    } catch (error) {
      logger.warn(`LyricProvider: Optimized repo check failed: ${error instanceof Error ? error.message : String(error)}`);
      // 继续使用传统的并行fetch方法
    }

    // 如果工作线程检查失败，回退到传统方法
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
        
        // 将结果存入缓存
        const cacheKey = `repo:${id}:${format}`;
        lyricsCache.set(cacheKey, fetchResult);
        
        return { 
          found: true as const, 
          id, 
          format: fetchResult.format, 
          source: 'repository', 
          content: fetchResult.content 
        };
      }
    }

    logger.info(`LyricProvider: Parallel repository fetches complete, no format found.`);
    return null;
  }

  private async findInExternalApi(id: string): Promise<SearchResult> {
    logger.info(`LyricProvider: Trying external API fallback.`);
    
    // 检查缓存
    const cacheKey = `external:${id}:any`;
    const cachedResult = lyricsCache.get(cacheKey);
    if (cachedResult) {
      logger.info(`Cache hit for external API with ID: ${id}`);
      return cachedResult;
    }
    
    try {
      // 设置超时控制
      const EXTERNAL_API_TIMEOUT_MS = 5000; // 5秒超时
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        logger.warn(`LyricProvider: External API request timed out after ${EXTERNAL_API_TIMEOUT_MS}ms`);
        controller.abort();
      }, EXTERNAL_API_TIMEOUT_MS);
      
      // 使用优化后的fetch函数
      const externalResult = await this.externalFetcher.fetch(id, undefined);
      
      // 清除超时
      clearTimeout(timeoutId);
      
      if (externalResult.status === 'found') {
        const result: SearchResult = {
          found: true as const,
          id,
          format: externalResult.format,
          source: 'external',
          content: externalResult.content,
          translation: externalResult.translation,
          romaji: externalResult.romaji
        };
        
        // 缓存结果
        lyricsCache.set(cacheKey, result);
        
        return result;
      }
      
      if (externalResult.status === 'error') {
        const errorResult: SearchResult = { 
          found: false, 
          id, 
          error: `External API fallback failed: ${externalResult.error.message}`, 
          statusCode: externalResult.statusCode 
        };
        return errorResult;
      }
      
      logger.info(`LyricProvider: External API fallback did not yield usable lyrics.`);
      return { found: false, id, error: 'Lyrics not found in external API', statusCode: 404 };
      
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const isTimeoutError = err.name === 'AbortError';
      
      logger.error(`LyricProvider: ${isTimeoutError ? 'Timeout' : 'Error'} during external API fallback: ${err.message}`);
      
      return {
        found: false,
        id,
        error: isTimeoutError 
          ? 'External API request timed out' 
          : `External API error: ${err.message}`,
        statusCode: isTimeoutError ? 408 : 502
      };
    }
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

// --- Internal Fetcher Functions ---

async function fetchRepoLyric(
  id: string,
  format: LyricFormat,
  logger: BasicLogger
): Promise<FetchResult> {
  const url = buildRawUrl(id, format);
  const cacheKey = `repo:${id}:${format}`;
  
  // 1. 检查缓存
  const cachedResult = lyricsCache.get(cacheKey);
  if (cachedResult) {
    logger.info(`Cache hit for repo ${format.toUpperCase()} lyrics with ID: ${id}`);
    return cachedResult;
  }
  
  logger.info(`Attempting fetch from GitHub repo for ${format.toUpperCase()}: ${url}`);
  
  try {
    // 2. 使用优化的HTTP客户端代替原生fetch
    const { content, statusCode, error } = await fetchContent(url, {
      timeout: 4000, // 4秒超时
      retries: 1,    // 出错时重试一次
    });
    
    if (error) {
      logger.error(`Network error during repo fetch for ${format.toUpperCase()}: ${error.message}`);
      return { status: 'error', format, error };
    }
    
    if (statusCode === 200 && content) {
      logger.info(`Repo fetch success for ${format.toUpperCase()} (status: ${statusCode})`);
      // 3. 缓存结果
      const result = { status: 'found', format, content, source: 'repository' } as FetchResult;
      lyricsCache.set(cacheKey, result);
      return result;
    } else if (statusCode === 404) {
      logger.info(`Repo fetch resulted in 404 for ${format.toUpperCase()}`);
      return { status: 'notfound', format };
    } else {
      logger.error(`Repo fetch failed for ${format.toUpperCase()} with HTTP status ${statusCode}`);
      return { status: 'error', format, statusCode, error: new Error(`HTTP error ${statusCode}`) };
    }
  } catch (err) {
    logger.error(`Unexpected error during repo fetch for ${format.toUpperCase()}`, err);
    const error = err instanceof Error ? err : new Error('Unknown fetch error');
    return { status: 'error', format, error };
  }
}

async function fetchExternalLyric(
  id: string,
  specificFormat: 'yrc' | 'lrc' | undefined,
  logger: BasicLogger
): Promise<FetchResult & { translation?: string; romaji?: string }> {
  const externalUrl = buildExternalApiUrl(id, process.env.EXTERNAL_NCM_API_URL);
  // 基于格式构建缓存键
  const formatString = specificFormat || 'any';
  const cacheKey = `external:${id}:${formatString}`;
  
  // 1. 检查缓存
  const cachedResult = lyricsCache.get(cacheKey);
  if (cachedResult) {
    logger.info(`Cache hit for external API lyrics with ID: ${id}, format: ${formatString}`);
    return cachedResult;
  }
  
  logger.info(`Attempting fetch from external API: ${externalUrl}`);
  
  try {
    // 2. 设置超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时
    
    // 3. 使用高性能HTTP客户端
    const { content, statusCode, error } = await fetchContent(externalUrl, {
      timeout: 5000,
      retries: 1
    });
    
    clearTimeout(timeoutId);
    
    if (error) {
      logger.error(`Network error during external API fetch for ID: ${id}: ${error.message}`);
      return { 
        status: 'error', 
        statusCode: error.name === 'AbortError' ? 408 : 502, 
        error: error 
      };
    }
    
    if (statusCode !== 200 || !content) {
      logger.error(`External API fetch failed with status: ${statusCode} for URL: ${externalUrl}`);
      return { 
        status: 'error', 
        statusCode: 502, 
        error: new Error(`External API failed with status ${statusCode}`) 
      };
    }
    
    // 4. JSON解析
    let externalData;
    try {
      externalData = JSON.parse(content);
    } catch (parseError) {
      logger.error(`Failed to parse JSON from external API for ID: ${id}`, parseError);
      return { 
        status: 'error', 
        statusCode: 502, 
        error: new Error('External API returned invalid JSON.') 
      };
    }
    
    // 5. 并行处理所有可能的歌词格式和翻译
    const translationRaw = filterLyricLines(externalData?.tlyric?.lyric);
    const translation = translationRaw === null ? undefined : translationRaw;
    const romajiRaw = filterLyricLines(externalData?.romalrc?.lyric);
    const romaji = romajiRaw === null ? undefined : romajiRaw;
    
    // 记录翻译情况
    logger.info(`Translation lyrics ${translation ? 'found' : 'not found'} in external API response.`);
    logger.info(`Romaji lyrics ${romaji ? 'found' : 'not found'} in external API response.`);
    
    // 6. 处理不同的格式请求
    let result: FetchResult & { translation?: string; romaji?: string } | null = null;
    
    if (specificFormat === 'yrc') {
      const filteredContent = filterLyricLines(externalData?.yrc?.lyric);
      if (filteredContent) {
        logger.info(`Found and filtered YRC lyrics in external API for ID: ${id}.`);
        result = { 
          status: 'found', 
          format: 'yrc', 
          source: 'external', 
          content: filteredContent, 
          translation, 
          romaji 
        };
      }
    } else if (specificFormat === 'lrc') {
      const filteredContent = filterLyricLines(externalData?.lrc?.lyric);
      if (filteredContent) {
        logger.info(`Found and filtered LRC lyrics in external API for ID: ${id}.`);
        result = { 
          status: 'found', 
          format: 'lrc', 
          source: 'external', 
          content: filteredContent, 
          translation, 
          romaji 
        };
      }
    } else {
      // 当不指定格式时，先尝试YRC，然后LRC
      const filteredYrc = filterLyricLines(externalData?.yrc?.lyric);
      if (filteredYrc) {
        logger.info(`Found and filtered YRC lyrics (default) in external API for ID: ${id}.`);
        result = { 
          status: 'found', 
          format: 'yrc', 
          source: 'external', 
          content: filteredYrc, 
          translation, 
          romaji 
        };
      } else {
        const filteredLrc = filterLyricLines(externalData?.lrc?.lyric);
        if (filteredLrc) {
          logger.info(`Found and filtered LRC lyrics (fallback) in external API for ID: ${id}.`);
          result = { 
            status: 'found', 
            format: 'lrc', 
            source: 'external', 
            content: filteredLrc, 
            translation, 
            romaji 
          };
        }
      }
    }
    
    // 7. 如果找到结果，缓存它
    if (result && result.status === 'found') {
      lyricsCache.set(cacheKey, result);
      return result;
    }
    
    logger.info(`No usable lyrics${specificFormat ? ` for format ${specificFormat}` : ''} found in external API response for ID: ${id}.`);
    return { status: 'notfound', format: specificFormat };
    
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`Unexpected error during external API fetch for ID: ${id}: ${err.message}`);
    const isTimeoutError = err.name === 'AbortError';
    
    return { 
      status: 'error', 
      statusCode: isTimeoutError ? 408 : 502, 
      error: err 
    };
  }
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
  const { logger } = options;
  logger.info("searchLyrics called, but it's a placeholder in this diff.");
  return { found: false, id, error: 'Not implemented in placeholder' };
}

// --- New Metadata Function ---

// 新增：轻量级检查外部 API 中可用的歌词格式（不读取内容）
async function checkExternalFormatsAvailability(
  id: string,
  logger: BasicLogger
): Promise<{ formats: LyricFormat[]; hasTranslation: boolean; hasRomaji: boolean; error?: Error; statusCode?: number }> {
  const externalUrl = buildExternalApiUrl(id, process.env.EXTERNAL_NCM_API_URL);
  logger.debug?.(`Metadata: Checking external API formats: ${externalUrl}`);
  
  try {
    // 设置较短的超时时间，因为这只是格式检查
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3秒超时
    
    const externalResponse = await fetch(externalUrl, { 
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    
    if (!externalResponse.ok) {
      logger.warn(`Metadata: External API check failed with status: ${externalResponse.status}`);
      return { 
        formats: [], 
        hasTranslation: false, 
        hasRomaji: false, 
        error: new Error(`External API failed with status ${externalResponse.status}`),
        statusCode: externalResponse.status
      };
    }

    // 解析JSON，但不处理歌词内容
    const externalData = await externalResponse.json() as any;
    const availableFormats: LyricFormat[] = [];
    let hasTranslation = false;
    let hasRomaji = false;

    // 检查各种格式是否存在（仅检查结构，不处理内容）
    if (externalData?.lrc?.lyric) {
      availableFormats.push('lrc');
    }
    
    if (externalData?.yrc?.lyric) {
      availableFormats.push('yrc');
    }
    
    if (externalData?.tlyric?.lyric) {
      hasTranslation = true;
    }
    
    if (externalData?.romalrc?.lyric) {
      hasRomaji = true;
    }

    logger.debug?.(`Metadata: External API formats found: ${availableFormats.join(', ')}`);
    logger.debug?.(`Metadata: Translation: ${hasTranslation}, Romaji: ${hasRomaji}`);
    
    return { formats: availableFormats, hasTranslation, hasRomaji };
    
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn(`Metadata: External API formats check failed: ${err.message}`);
    
    // 判断是否为超时错误
    const isTimeoutError = err.name === 'AbortError';
    if (isTimeoutError) {
      logger.warn(`Metadata: External API request timed out after 3 seconds`);
    }
    
    return { 
      formats: [], 
      hasTranslation: false, 
      hasRomaji: false, 
      error: err,
      statusCode: isTimeoutError ? 408 : 502
    };
  }
}

// 修改 getLyricMetadata 函数以实现更激进的并行优化
export async function getLyricMetadata(
  id: string,
  options: {
    logger: BasicLogger;
  }
): Promise<LyricMetadataResult> {
  const { logger } = options;
  logger.info(`LyricService: Getting metadata for ID: ${id}`);

  // 定义总体超时时间
  const TOTAL_TIMEOUT_MS = 6000; // 提高到6秒总超时
  const EARLY_RETURN_TIMEOUT_MS = 4000; // 提高到4秒后如果有任何格式，提前返回
  const MIN_FORMATS_FOR_INSTANT_RETURN = 3; // 提高到找到至少3种格式才立即返回
  
  // 创建存储结果的状态对象
  const state = {
    foundFormats: new Set<LyricFormat>(),
    hasTranslation: false,
    hasRomaji: false,
    error: undefined as string | undefined,
    statusCode: undefined as number | undefined,
    // 用于提前结束的标志
    shouldReturnEarly: false,
    earlyReturnTriggered: false,
    // 记录已完成的检查总数
    completedChecks: 0,
    totalChecks: 0,
    // 优先级格式计数
    priorityFormatsFound: 0
  };

  // 创建整体超时控制器
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    logger.warn(`Metadata: Overall check timed out after ${TOTAL_TIMEOUT_MS}ms`);
    abortController.abort();
  }, TOTAL_TIMEOUT_MS);
  
  // 创建提前返回定时器
  const earlyReturnId = setTimeout(() => {
    // 如果已经找到了任何格式，就标记为可以提前返回
    if (state.foundFormats.size > 0 && !state.earlyReturnTriggered) {
      logger.info(`Metadata: Early return timer triggered after ${EARLY_RETURN_TIMEOUT_MS}ms with ${state.foundFormats.size} formats found`);
      state.shouldReturnEarly = true;
    }
  }, EARLY_RETURN_TIMEOUT_MS);

  try {
    // 定义所有要检查的格式
    const repoFormatsToConsider: LyricFormat[] = [
      'ttml',
      ...DEFAULT_FALLBACK_ORDER.filter(f => f !== 'ttml')
    ];
    const uniqueRepoFormats = [...new Set(repoFormatsToConsider)];
    
    // 优先级格式 - 这些格式更重要
    const priorityFormats = new Set<LyricFormat>(['ttml', 'yrc', 'lrc']);

    // 设置总检查数
    state.totalChecks = uniqueRepoFormats.length + 1; // +1 是外部API检查
    
    logger.debug?.(`Metadata: Starting parallel checks for repository and external API`);
    
    // 1. 创建一个函数处理仓库格式检查结果
    const handleRepoFormatCheck = async (format: LyricFormat) => {
      try {
        const result = await checkRepoFormatExistence(id, format, logger);
        
        // 增加完成计数
        state.completedChecks++;
        const completionPercentage = Math.floor((state.completedChecks / state.totalChecks) * 100);
        
        if (result.exists) {
          state.foundFormats.add(format);
          logger.debug?.(`Metadata: Found ${format} in repository (completion: ${completionPercentage}%)`);
          
          // 检查是否为优先级格式
          if (priorityFormats.has(format)) {
            state.priorityFormatsFound++;
          }
        }
      } catch (error) {
        // 单个格式检查错误不影响整体结果，记录日志即可
        state.completedChecks++;
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Metadata: Error checking ${format} in repository: ${msg}`);
      }
    };
    
    // 2. 创建外部API检查处理函数
    const handleExternalCheck = async () => {
      try {
        const result = await checkExternalFormatsAvailability(id, logger);
        
        // 增加完成计数
        state.completedChecks++;
        const completionPercentage = Math.floor((state.completedChecks / state.totalChecks) * 100);
        logger.debug?.(`Metadata: External API check completed (completion: ${completionPercentage}%)`);
        
        // 添加外部API找到的格式
        result.formats.forEach(format => {
          state.foundFormats.add(format);
          logger.debug?.(`Metadata: Found ${format} in external API`);
          
          // 检查是否为优先级格式
          if (priorityFormats.has(format)) {
            state.priorityFormatsFound++;
          }
        });
        
        // 设置翻译和罗马音状态
        if (result.hasTranslation) {
          state.hasTranslation = true;
          logger.debug?.(`Metadata: Translation available in external API`);
        }
        
        if (result.hasRomaji) {
          state.hasRomaji = true;
          logger.debug?.(`Metadata: Romaji available in external API`);
        }
        
        // 处理错误
        if (result.error) {
          state.error = `External API error: ${result.error.message}`;
          state.statusCode = result.statusCode;
        }
      } catch (error) {
        state.completedChecks++;
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Metadata: Error checking external API: ${msg}`);
        state.error = `External API error: ${msg}`;
      }
    };
    
    // 3. 创建所有并行任务 - 仓库格式检查和外部API检查完全并行
    const allTasks = [
      ...uniqueRepoFormats.map(format => handleRepoFormatCheck(format)),
      handleExternalCheck()
    ];
    
    // 4. 使用Promise.race实现更平衡的早期返回逻辑
    const monitorEarlyReturn = async () => {
      while (!state.earlyReturnTriggered && !abortController.signal.aborted) {
        // 每100ms检查一次是否可以提前返回
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // 多级别返回条件
        // 1. 如果完成了至少75%的检查，且找到了至少一种格式，可以提前返回
        const hasHighCompletion = (state.completedChecks / state.totalChecks) >= 0.75 && state.foundFormats.size > 0;
        
        // 2. 如果找到了至少MIN_FORMATS_FOR_INSTANT_RETURN种格式，可以提前返回
        const hasMultipleFormats = state.foundFormats.size >= MIN_FORMATS_FOR_INSTANT_RETURN;
        
        // 3. 如果找到了至少2种优先级格式，可以提前返回
        const hasPriorityFormats = state.priorityFormatsFound >= 2;
        
        // 4. 如果已经设置了shouldReturnEarly标志（由计时器触发），且找到了至少一种格式，可以提前返回
        const timerTriggeredReturn = state.shouldReturnEarly && state.foundFormats.size > 0;
        
        // 任一条件满足即可提前返回
        if (hasHighCompletion || hasMultipleFormats || hasPriorityFormats || timerTriggeredReturn) {
          // 记录提前返回的原因
          let reason = 'unknown';
          if (hasHighCompletion) reason = `high completion (${Math.floor((state.completedChecks / state.totalChecks) * 100)}%)`;
          else if (hasMultipleFormats) reason = `multiple formats (${state.foundFormats.size})`;
          else if (hasPriorityFormats) reason = `priority formats (${state.priorityFormatsFound})`;
          else if (timerTriggeredReturn) reason = `timer triggered`;
          
          state.earlyReturnTriggered = true;
          logger.info(`Metadata: Early return with ${state.foundFormats.size} formats found. Reason: ${reason}`);
          return;
        }
      }
    };
    
    // 5. 创建总超时Promise
    const timeoutPromise = new Promise<void>((_, reject) => {
      abortController.signal.addEventListener('abort', () => {
        reject(new Error('Overall metadata check timed out'));
      });
    });
    
    // 6. 用Promise.race实现早期返回或超时
    await Promise.race([
      // 早期返回监控
      monitorEarlyReturn(),
      // 总超时
      timeoutPromise,
      // 如果所有任务都完成了
      Promise.all(allTasks).then(() => {
        logger.debug?.(`Metadata: All format checks completed normally`);
      })
    ]);
    
    // 7. 至此，要么提前返回、要么超时、要么所有任务都完成 - 构建响应
    logger.info(`Metadata: Check completed with ${state.foundFormats.size} formats found (${state.completedChecks}/${state.totalChecks} checks completed)`);
    
    // 构建并返回结果
    const finalAvailableFormats = Array.from(state.foundFormats);
    
    if (finalAvailableFormats.length > 0) {
      return {
        found: true,
        id,
        availableFormats: finalAvailableFormats,
        hasTranslation: state.hasTranslation,
        hasRomaji: state.hasRomaji,
      };
    } else {
      return {
        found: false,
        id,
        error: state.error || "No lyric formats found in repository or external API.",
        statusCode: state.statusCode || 404
      };
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    
    // 检查是否是我们自己的超时错误
    if (err.message.includes('timed out') || err.name === 'AbortError') {
      logger.warn(`Metadata: ${err.message}`);
      // 超时了，但可能已经找到一些格式，还是可以返回
      const finalAvailableFormats = Array.from(state.foundFormats);
      
      if (finalAvailableFormats.length > 0) {
        logger.info(`Metadata: Returning ${finalAvailableFormats.length} formats despite timeout`);
        return {
          found: true,
          id,
          availableFormats: finalAvailableFormats,
          hasTranslation: state.hasTranslation,
          hasRomaji: state.hasRomaji,
        };
      } else {
        return {
          found: false,
          id,
          error: "Metadata check timed out without finding any formats",
          statusCode: 408 // Request Timeout
        };
      }
    }
    
    // 其他未预期的错误
    logger.error(`Metadata: Unexpected error during metadata check: ${err.message}`);
    return {
      found: false,
      id,
      error: `Failed to check lyric metadata: ${err.message}`,
      statusCode: 500
    };
  } finally {
    // 清理计时器
    clearTimeout(timeoutId);
    clearTimeout(earlyReturnId);
  }
}

// 更新 checkRepoFormatExistence 函数以支持超时
async function checkRepoFormatExistence(
  id: string,
  format: LyricFormat,
  logger: BasicLogger
): Promise<{ format: LyricFormat; exists: boolean; error?: Error }> {
  const url = buildRawUrl(id, format);
  logger.debug?.(`Metadata: Checking repo existence for ${format.toUpperCase()}: ${url}`);
  
  try {
    // 设置 2 秒超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    
    const response = await fetch(url, { 
      method: 'HEAD',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      logger.debug?.(`Metadata: Repo format ${format.toUpperCase()} exists`);
      return { format, exists: true };
    } else if (response.status === 404) {
      logger.debug?.(`Metadata: Repo format ${format.toUpperCase()} does not exist`);
      return { format, exists: false };
    } else {
      logger.warn(`Metadata: Repo format ${format.toUpperCase()} check returned status ${response.status}`);
      return { format, exists: false, error: new Error(`HTTP error ${response.status}`) };
    }
  } catch (err) {
    // 检查是否是超时错误
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn(`Metadata: Repo check for ${format} timed out after 2 seconds`);
      return { format, exists: false, error: new Error('Request timed out') };
    }
    
    const error = err instanceof Error ? err : new Error('Unknown fetch error');
    logger.error(`Metadata: Repo check for ${format} failed: ${error.message}`);
    return { format, exists: false, error };
  }
}
import { getLogger } from './utils';
import pLimit from 'p-limit';

const logger = getLogger('HttpClient');

// 创建并发限制器
const MAX_CONCURRENT_REQUESTS = 15;
const requestLimit = pLimit(MAX_CONCURRENT_REQUESTS);

/**
 * 使用Web标准fetch API执行HEAD请求检查资源是否存在
 * Edge Runtime完全兼容版本
 */
export async function checkResourceExists(
  url: string,
  options: {
    timeout?: number;
    retries?: number;
  } = {}
): Promise<{ exists: boolean; statusCode?: number; error?: Error }> {
  const { timeout = 2000, retries = 1 } = options;
  
  return requestLimit(async () => {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        logger.debug(`Retry ${attempt}/${retries} for ${url}`);
      }
      
      try {
        // 创建AbortController用于超时
        const controller = new AbortController();
        const signal = controller.signal;
        
        // 设置超时
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, timeout);
        
        try {
          const response = await fetch(url, {
            method: 'HEAD',
            signal
          });
          
          clearTimeout(timeoutId);
          
          return { 
            exists: response.status === 200,
            statusCode: response.status
          };
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.debug(`Request failed for ${url}: ${lastError.message}`);
        
        // 如果是超时错误，标记为AbortError
        if (lastError.name === 'AbortError') {
          lastError = new Error(`Request timeout after ${timeout}ms`);
          lastError.name = 'AbortError';
        }
        
        // 如果不是最后一次尝试，等待一点时间再重试
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        }
      }
    }
    
    return { 
      exists: false, 
      error: lastError 
    };
  });
}

/**
 * 使用Web标准fetch API获取完整响应内容
 * Edge Runtime完全兼容版本
 */
export async function fetchContent(
  url: string, 
  options: {
    timeout?: number;
    retries?: number;
    headers?: Record<string, string>;
  } = {}
): Promise<{ content?: string; statusCode?: number; error?: Error }> {
  const { timeout = 5000, retries = 1, headers = {} } = options;
  
  return requestLimit(async () => {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        logger.debug(`Retry ${attempt}/${retries} for ${url}`);
      }
      
      try {
        // 创建AbortController用于超时
        const controller = new AbortController();
        const signal = controller.signal;
        
        // 设置超时
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, timeout);
        
        try {
          const response = await fetch(url, {
            method: 'GET',
            headers,
            signal
          });
          
          if (response.status === 200) {
            const content = await response.text();
            return { content, statusCode: response.status };
          } else {
            return { statusCode: response.status };
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.debug(`Fetch failed for ${url}: ${lastError.message}`);
        
        // 如果是超时错误，标记为AbortError
        if (lastError.name === 'AbortError') {
          lastError = new Error(`Request timeout after ${timeout}ms`);
          lastError.name = 'AbortError';
        }
        
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }
    
    return { error: lastError };
  });
} 
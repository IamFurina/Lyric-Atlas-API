import { getLogger } from './utils';

const logger = getLogger('Cache');

// 确保缓存在Vercel Edge Functions环境中可用
// 使用Map作为内存缓存，这在Edge Runtime中是完全支持的
// 通用缓存接口
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// 创建类型化的缓存管理器
export class Cache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private ttl: number; // 缓存生存时间(毫秒)
  private name: string;
  private maxSize: number;

  constructor(name: string, ttlInMs: number, maxSize: number = 1000) {
    this.cache = new Map();
    this.ttl = ttlInMs;
    this.name = name;
    this.maxSize = maxSize;
    logger.info(`Cache '${name}' initialized with TTL: ${ttlInMs}ms, maxSize: ${maxSize}`);
  }

  // 获取缓存的项目
  get(key: string): T | null {
    const now = Date.now();
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // 检查是否过期
    if (now - entry.timestamp > this.ttl) {
      logger.debug(`Cache '${this.name}': Entry for key '${key}' expired`);
      this.cache.delete(key);
      return null;
    }

    logger.debug(`Cache '${this.name}': Hit for key '${key}'`);
    return entry.data;
  }

  // 设置缓存项目
  set(key: string, data: T): void {
    // 如果达到最大大小，删除最旧的条目
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.findOldestEntry();
      if (oldestKey) {
        logger.debug(`Cache '${this.name}': Evicting oldest entry '${oldestKey}' due to size limit`);
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    logger.debug(`Cache '${this.name}': Set key '${key}'`);
  }

  // 查找最旧的条目
  private findOldestEntry(): string | null {
    if (this.cache.size === 0) return null;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  // 手动清除缓存中的项目
  invalidate(key: string): boolean {
    logger.debug(`Cache '${this.name}': Invalidating key '${key}'`);
    return this.cache.delete(key);
  }

  // 获取缓存大小
  size(): number {
    return this.cache.size;
  }

  // 清除所有缓存
  clear(): void {
    logger.info(`Cache '${this.name}': Clearing all entries`);
    this.cache.clear();
  }

  // 清除过期的项目
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cache '${this.name}': Cleaned up ${cleaned} expired entries`);
    }
    return cleaned;
  }
}

// 默认缓存实例
// 元数据缓存 - 30分钟TTL
export const metadataCache = new Cache<any>('metadata', 30 * 60 * 1000, 2000);

// 歌词内容缓存 - 60分钟TTL
export const lyricsCache = new Cache<any>('lyrics', 60 * 60 * 1000, 1000);

// 导出执行定期清理的函数
export function setupCacheCleanup(intervalMs: number = 15 * 60 * 1000): ReturnType<typeof setInterval> {
  logger.info(`Setting up cache cleanup interval: ${intervalMs}ms`);
  return setInterval(() => {
    metadataCache.cleanup();
    lyricsCache.cleanup();
  }, intervalMs);
} 
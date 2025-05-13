import { getLogger } from './utils';
import { LyricFormat } from './utils';
import { checkResourceExists } from './httpClient';

const logger = getLogger('Workers');

// 格式检查结果接口
export interface FormatCheckResult {
  availableFormats: LyricFormat[];
  errors: Record<string, string>;
}

/**
 * 检查多个歌词格式是否可用
 * 边缘函数兼容版本 - 不使用worker_threads
 */
export async function checkMultipleFormatsWithWorker(
  id: string,
  formats: LyricFormat[],
  repoBaseUrl: string = 'https://raw.githubusercontent.com'
): Promise<FormatCheckResult> {
  logger.info(`Checking formats for ID: ${id}, formats: ${formats.join(', ')}`);
  
  // 构建完整paths
  const paths = formats.map(format => `/Steve-XMH/amll-ttml-db/main/ncm-lyrics/${id}.${format}`);
  
  // Promise.all实现的并行检查
  const checkPromises = paths.map((path, index) => {
    const url = `${repoBaseUrl}${path}`;
    return checkResourceExists(url, { timeout: 3000 })
      .then(result => ({ format: formats[index], ...result }));
  });
  
  // 等待所有检查完成
  const results = await Promise.all(checkPromises);
  
  // 整理结果
  const availableFormats: LyricFormat[] = [];
  const errors: Record<string, string> = {};
  
  for (const { format, exists, error } of results) {
    if (exists) {
      availableFormats.push(format);
    } else if (error) {
      errors[format] = error.message || String(error);
    }
  }
  
  return {
    availableFormats,
    errors
  };
}

// 空方法，为了保持API兼容性
export async function shutdownWorkers(): Promise<void> {
  // 无需关闭worker，因为没有使用worker_threads
  return Promise.resolve();
} 
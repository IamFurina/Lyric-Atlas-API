// 移除worker_threads和http2导入，这些在Edge Runtime中不可用
export default async function handleCheckMultipleFormats(task) {
  const { id, formats, repoBaseUrl } = task;
  
  // 构建完整paths
  const paths = formats.map(format => `/Steve-XMH/amll-ttml-db/main/ncm-lyrics/${id}.${format}`);
  
  // 使用标准fetch API并行处理所有检查
  const results = await Promise.all(
    paths.map(async (path, index) => {
      const url = `${repoBaseUrl}${path}`;
      
      try {
        const response = await fetch(url, { 
          method: 'HEAD',
          signal: AbortSignal.timeout(3000) // 3秒超时
        });
        return { 
          format: formats[index], 
          exists: response.status === 200,
          statusCode: response.status
        };
      } catch (error) {
        return { 
          format: formats[index], 
          exists: false, 
          error: error.message || 'Unknown error' 
        };
      }
    })
  );
  
  // 整理结果
  const availableFormats = [];
  const errors = {};
  
  for (const { format, exists, error } of results) {
    if (exists) {
      availableFormats.push(format);
    } else if (error) {
      errors[format] = error;
    }
  }
  
  return {
    availableFormats,
    errors
  };
} 
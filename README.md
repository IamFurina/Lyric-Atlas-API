# Lyric Atlas API

一个简单的 Node.js API 服务器，用于获取网易云音乐歌曲的歌词，它会优先从指定的 GitHub 仓库获取 TTML 格式，然后按顺序查找仓库中的其他格式，最后回退到一个外部 NCM API。

## 特性

*   优先从 [Steve-XMH/amll-ttml-db](https://github.com/Steve-XMH/amll-ttml-db) 仓库获取 `ttml` 歌词。
*   当 TTML 未找到时，按顺序查找仓库中的 `yrc`, `lrc`, `eslrc` 格式（可通过 `fallback` 参数自定义顺序）。
*   当仓库中所有格式都未找到时，回退到外部 API (通过 `EXTERNAL_NCM_API_URL` 环境变量配置) 获取 `yrc` 或 `lrc`。(外部 API 为 NeteaseCloudMusicApi)
*   支持通过 `fixedVersion` 参数强制只查找仓库中的特定格式。
*   使用 [Hono](https://www.hono.dev/) 构建，性能高效。

## API 端点

### `GET /api/search`

根据提供的网易云音乐歌曲 ID 搜索歌词。

**查询参数:**

*   `id` ( **必需** ): 网易云音乐歌曲的数字 ID。
*   `fixedVersion` ( *可选* ): 强制只在 GitHub 仓库中查找指定的歌词格式。如果提供此参数，则忽略 `fallback` 参数。有效值: `ttml`, `yrc`, `lrc`, `eslrc`。
*   `fallback` ( *可选* ): 指定在 GitHub 仓库中未找到 `ttml` 格式后，按顺序尝试查找的回退格式列表（逗号分隔）。**注意:** 此列表不应包含 `ttml`。如果忽略此参数，默认的回退顺序是 `yrc,lrc,eslrc`。

**响应:**

*   **成功 (200 OK):**
    ```json
    {
      "found": true,
      "id": "歌曲ID",
      "format": "找到的格式 (ttml, yrc, lrc, eslrc)",
      "source": "来源 ('repository' 或 'external')",
      "content": "歌词文件的文本内容"
    }
    ```
*   **未找到 (404 Not Found):**
    ```json
    {
      "found": false,
      "id": "歌曲ID",
      "error": "错误信息 (例如 'Lyrics not found')"
    }
    ```
*   **客户端错误 (400 Bad Request):**
    ```json
    {
      "error": "错误信息 (例如 'Missing id parameter')"
    }
    ```
*   **服务器错误 (5xx):**
    ```json
    {
      "error": "错误信息 (例如 'Failed to fetch ...', 'External API fallback failed ...')"
    }
    ```

**示例请求:**

*   `GET /api/search?id=449818741` (默认查找顺序: ttml -> yrc -> lrc -> eslrc -> external)
*   `GET /api/search?id=449818741&fallback=lrc,yrc` (查找顺序: ttml -> lrc -> yrc -> external)
*   `GET /api/search?id=449818741&fixedVersion=ttml` (只查找仓库中的 ttml)

### `GET /api/lyrics/meta`

快速检查某个歌曲 ID 是否存在歌词，并返回可用的歌词格式列表以及是否有翻译或罗马音（来自外部 API）。此端点不返回完整的歌词内容，设计用于轻量级检查。

**查询参数:**

*   `id` ( **必需** ): 网易云音乐歌曲的数字 ID。

**响应:**

*   **成功 (200 OK):**
    ```json
    {
      "found": true,
      "id": "歌曲ID",
      "availableFormats": ["ttml", "lrc"], // 可能的格式列表 (LyricFormat[])
      "hasTranslation": true, // 布尔值，指示外部 API 是否提供翻译
      "hasRomaji": false      // 布尔值，指示外部 API 是否提供罗马音
    }
    ```
*   **未找到 (404 Not Found):**
    ```json
    {
      "found": false,
      "id": "歌曲ID",
      "error": "错误信息 (例如 'No lyric formats found')"
    }
    ```
*   **客户端错误 (400 Bad Request):**
    ```json
    {
      "found": false, // 注意：为了与 search 保持一致性，这里也返回 found: false
      "error": "错误信息 (例如 'Missing id parameter')"
    }
    ```
*   **服务器错误 (5xx):**
    ```json
    {
      "found": false,
      "error": "错误信息"
    }
    ```

**示例请求:**

*   `GET /api/lyrics/meta?id=449818741`

## 数据来源

1.  **主要来源:** [Steve-XMH/amll-ttml-db](https://github.com/Steve-XMH/amll-ttml-db) GitHub 仓库 (`/ncm-lyrics` 目录)。
2.  **回退来源:** 通过 `EXTERNAL_NCM_API_URL` 环境变量配置的外部 API。

## 安装与运行

1.  **克隆仓库:**
    ```bash
    git clone <你的仓库URL>
    cd <仓库目录>
    ```
2.  **安装依赖:** 推荐使用 `pnpm`:
    ```bash
    pnpm install
    ```
    (或者使用 `npm install` 或 `yarn install`)
3.  **配置环境变量:**
    *   **开发:** 创建一个 `.env` 文件在项目根目录，并添加必需的环境变量：
        ```dotenv
        # .env
        EXTERNAL_NCM_API_URL=https://NeteaseCloudMusicApi/lyric/new
        PORT=3000 # 可选，默认 3000
        ```
        **重要:** 将 `.env` 文件添加到 `.gitignore`。
    *   **生产:** 通过你的部署平台或系统设置相应的环境变量。
4.  **开发模式 (带热重载):**
    ```bash
    pnpm run dev
    ```
    服务器将在 `http://localhost:3000` (或 `PORT` 环境变量指定的端口) 启动。
5.  **构建生产版本:**
    ```bash
    pnpm run build
    ```
    确保 `tsconfig.json` 中 `outDir` 配置为 `./dist` 并且 `noEmit` 为 `false` 或已移除。
6.  **运行生产版本:**
    ```bash
    pnpm run start
    ```

## 环境变量

*   `EXTERNAL_NCM_API_URL` ( **必需** ): 指定外部回退 NCM API 的基础 URL (例如: `https://ncm-api/lyric/new`)。服务器在启动时会检查此变量。
*   `PORT`: 指定服务器监听的端口 (默认: `3000`)。

## 部署

这是一个标准的 Node.js Fastify 应用，可以部署到任何支持 Node.js 的平台，例如 Heroku, Render, Fly.io, 或你自己的服务器。确保目标环境安装了生产依赖 (`dependencies` 而非 `devDependencies`)，设置了必需的环境变量 (`EXTERNAL_NCM_API_URL`)，并使用 `pnpm run start` (或等效命令) 启动。

## 许可证

GNU GENERAL PUBLIC LICENSE v3.
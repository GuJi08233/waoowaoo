/**
 * Agnes AI 生成器
 *
 * 支持：
 * - Agnes Image 2.0 Flash / 2.1 Flash (文生图、图生图)
 * - Agnes Video V2.0 (文生视频、图生视频、关键帧动画)
 *
 * 文档: https://wiki.agnes-ai.com/llms.txt
 */

import { logInfo as _ulogInfo, logWarn as _ulogWarn, logError as _ulogError } from '@/lib/logging/core'
import type {
  ImageGenerator,
  ImageGenerateParams,
  VideoGenerator,
  VideoGenerateParams,
  GenerateResult,
} from './base'
import { getProviderConfig } from '@/lib/api-config'

// ============================================================
// 常量
// ============================================================

const AGNES_BASE_URL_GLOBAL = 'https://apihub.agnes-ai.com/v1'
const AGNES_BASE_URL_CN = 'https://apihub.agnes-ai.cn/v1'
const IMAGE_ENDPOINT = '/images/generations'
const VIDEO_ENDPOINT = '/videos'
const VIDEO_STATUS_ENDPOINT = '/agnesapi'

// 默认超时
const IMAGE_TIMEOUT_MS = 360_000  // 6 分钟
const VIDEO_CREATE_TIMEOUT_MS = 60_000  // 1 分钟
const VIDEO_POLL_TIMEOUT_MS = 600_000  // 10 分钟
const VIDEO_POLL_INTERVAL_MS = 5_000  // 5 秒

// Agnes Image 支持的宽高比（文档）
const AGNES_IMAGE_RATIOS = new Set([
  '1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9',
])

// ============================================================
// 工具函数
// ============================================================

function getBaseUrl(userId: string, providerId?: string): Promise<string> {
  return getProviderConfig(userId, providerId || 'agnes').then(config => {
    // 优先使用用户配置的 baseUrl
    if (config?.baseUrl) {
      return config.baseUrl
    }
    // 默认使用国际站
    return AGNES_BASE_URL_GLOBAL
  }).catch(() => AGNES_BASE_URL_GLOBAL)
}

function getApiKey(userId: string, providerId?: string): Promise<string> {
  return getProviderConfig(userId, providerId || 'agnes').then(config => {
    return config?.apiKey || ''
  }).catch(() => '')
}

// ============================================================
// Agnes Image Generator
// ============================================================

export class AgnesImageGenerator implements ImageGenerator {
  async generate(params: ImageGenerateParams): Promise<GenerateResult> {
    const { userId, prompt, referenceImages, options } = params
    const modelId = (options?.modelId as string) || 'agnes-image-2.1-flash'
    const providerId = (options?.provider as string) || 'agnes'

    const [baseUrl, apiKey] = await Promise.all([
      getBaseUrl(userId, providerId),
      getApiKey(userId, providerId),
    ])

    if (!apiKey) {
      return { success: false, error: 'Agnes API Key not configured' }
    }

    const endpoint = `${baseUrl}${IMAGE_ENDPOINT}`

    // 构建请求体
    // size: 文档推荐档位式 (1K/2K/3K/4K)，也兼容精确尺寸写法
    // 未指定 size 时默认 1K 档位，配合 ratio 使用
    const body: Record<string, unknown> = {
      model: modelId,
      prompt,
      size: options?.size || '1K',
    }

    // 宽高比（校验支持的取值）
    if (options?.aspectRatio && AGNES_IMAGE_RATIOS.has(options.aspectRatio)) {
      body.ratio = options.aspectRatio
    }

    // 图生图
    if (referenceImages && referenceImages.length > 0) {
      body.extra_body = {
        ...((body.extra_body as Record<string, unknown>) || {}),
        image: referenceImages,
      }
    }

    // 输出格式 (默认 URL)
    const responseFormat = (options?.outputFormat as string) || 'url'
    if (responseFormat === 'b64_json' || responseFormat === 'base64') {
      body.return_base64 = true
    } else {
      body.extra_body = {
        ...((body.extra_body as Record<string, unknown>) || {}),
        response_format: 'url',
      }
    }

    _ulogInfo(`[AgnesImage] Generating: model=${modelId}, size=${body.size}`)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS)

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        _ulogError(`[AgnesImage] HTTP ${response.status}: ${errorText}`)
        return {
          success: false,
          error: `Agnes Image API error: ${response.status} ${errorText.slice(0, 200)}`,
        }
      }

      const data = await response.json() as {
        data?: Array<{ url?: string | null; b64_json?: string | null }>
      }

      if (!data.data || data.data.length === 0) {
        return { success: false, error: 'Agnes Image API returned empty result' }
      }

      const result = data.data[0]

      if (result.b64_json) {
        const base64Data = result.b64_json
        const dataUri = base64Data.startsWith('data:')
          ? base64Data
          : `data:image/png;base64,${base64Data}`
        _ulogInfo(`[AgnesImage] Success (base64)`)
        return { success: true, imageBase64: dataUri }
      }

      if (result.url) {
        _ulogInfo(`[AgnesImage] Success: ${result.url}`)
        return { success: true, imageUrl: result.url }
      }

      return { success: false, error: 'Agnes Image API returned no image data' }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'Agnes Image generation timed out' }
      }
      _ulogError(`[AgnesImage] Error: ${error}`)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Agnes Image generation failed',
      }
    }
  }
}

// ============================================================
// Agnes Video Generator
// ============================================================

interface AgnesVideoTaskResponse {
  id?: string
  task_id?: string
  video_id?: string
  object?: string
  model?: string
  status?: string
  progress?: number
  created_at?: number
  seconds?: string
  size?: string
}

interface AgnesVideoStatusResponse {
  id?: string
  video_id?: string
  task_id?: string
  object?: string
  model?: string
  status?: string
  progress?: number
  created_at?: number
  completed_at?: number
  seconds?: string
  size?: string
  metadata?: {
    url?: string
    size_mapping?: Record<string, unknown>
  }
  // 兼容其他可能的 URL 字段位置
  url?: string | null
  video_url?: string | null
  result?: { url?: string }
  data?: { url?: string } | { url?: string }[]
  output?: { url?: string }
  error?: { message?: string } | null
}

/**
 * 从各种可能的响应结构中提取视频 URL
 */
function extractVideoUrl(data: AgnesVideoStatusResponse): string | undefined {
  // 文档格式：metadata.url
  if (typeof data.metadata?.url === 'string' && data.metadata.url.trim()) {
    return data.metadata.url.trim()
  }
  // 顶层 url
  if (typeof data.url === 'string' && data.url.trim()) {
    return data.url.trim()
  }
  // 顶层 video_url
  if (typeof data.video_url === 'string' && data.video_url.trim()) {
    return data.video_url.trim()
  }
  // result.url
  if (typeof data.result?.url === 'string' && data.result.url.trim()) {
    return data.result.url.trim()
  }
  // output.url
  if (typeof data.output?.url === 'string' && data.output.url.trim()) {
    return data.output.url.trim()
  }
  // data.url (对象或数组)
  if (data.data) {
    if (Array.isArray(data.data) && typeof data.data[0]?.url === 'string') {
      return data.data[0].url.trim()
    }
    if (!Array.isArray(data.data) && typeof data.data.url === 'string') {
      return data.data.url.trim()
    }
  }
  return undefined
}

export class AgnesVideoGenerator implements VideoGenerator {
  async generate(params: VideoGenerateParams): Promise<GenerateResult> {
    const { userId, imageUrl, prompt, options } = params
    const modelId = (options?.modelId as string) || 'agnes-video-v2.0'
    const providerId = (options?.provider as string) || 'agnes'

    const [baseUrl, apiKey] = await Promise.all([
      getBaseUrl(userId, providerId),
      getApiKey(userId, providerId),
    ])

    if (!apiKey) {
      return { success: false, error: 'Agnes API Key not configured' }
    }

    // 1. 创建视频任务
    const createResult = await this.createTask(baseUrl, apiKey, modelId, imageUrl, prompt, options)
    if (!createResult.success) {
      return createResult
    }

    const taskId = createResult.requestId!
    const externalId = createResult.externalId!
    // 同时记录 video_id 和 task_id（文档说明两者可能不同）
    const videoId = createResult.videoId
    const taskIdFallback = createResult.taskIdFallback

    _ulogInfo(`[AgnesVideo] Task created: ${taskId}, video_id=${videoId || 'N/A'}, task_id=${taskIdFallback || 'N/A'}`)

    // 2. 轮询等待结果
    return this.pollForResult(baseUrl, apiKey, taskId, externalId, modelId, videoId, taskIdFallback)
  }

  private async createTask(
    baseUrl: string,
    apiKey: string,
    modelId: string,
    imageUrl?: string,
    prompt?: string,
    options?: Record<string, unknown>,
  ): Promise<GenerateResult & { videoId?: string; taskIdFallback?: string }> {
    const endpoint = `${baseUrl}${VIDEO_ENDPOINT}`

    const body: Record<string, unknown> = {
      model: modelId,
      prompt: prompt || 'Generate a video',
    }

    // 图生视频 (单图)
    if (imageUrl && !options?.keyframeImages) {
      body.image = imageUrl
    }

    // 关键帧动画模式
    const keyframeImages = options?.keyframeImages as string[] | undefined
    if (keyframeImages && keyframeImages.length > 0) {
      body.extra_body = {
        image: keyframeImages,
        mode: 'keyframes',
      }
      body.mode = 'keyframes'
    }

    // 生成模式 (ti2vid, keyframes)
    if (options?.mode && typeof options.mode === 'string') {
      body.mode = options.mode
    }

    // negative_prompt (反向提示词)
    if (options?.negativePrompt && typeof options.negativePrompt === 'string') {
      body.negative_prompt = options.negativePrompt
    }

    // seed (随机种子)
    if (options?.seed && typeof options.seed === 'number') {
      body.seed = options.seed
    }

    // num_inference_steps (推理步数)
    if (options?.inferenceSteps && typeof options.inferenceSteps === 'number') {
      body.num_inference_steps = options.inferenceSteps
    }

    // 视频时长参数
    // frame_rate 支持范围 1-60（文档规定）
    const rawFps = (options?.fps as number) || 24
    const fps = Math.min(60, Math.max(1, Math.round(rawFps)))
    if (options?.duration) {
      // 根据时长计算 num_frames
      const frames = Math.ceil((options.duration as number) * fps)
      // 遵循 8n + 1 规则，最大 441（文档规定）
      body.num_frames = Math.min(441, Math.floor((frames - 1) / 8) * 8 + 1)
      body.frame_rate = fps
    } else {
      body.num_frames = 121
      body.frame_rate = fps
    }

    // 分辨率
    if (options?.resolution === '1080p') {
      body.width = 1920
      body.height = 1080
    } else if (options?.resolution === '720p') {
      body.width = 1280
      body.height = 720
    } else if (options?.resolution === '480p') {
      body.width = 832
      body.height = 480
    } else {
      body.width = 1152
      body.height = 768
    }

    // 宽高比调整
    if (options?.aspectRatio === '9:16') {
      const tmp = body.width as number
      body.width = body.height
      body.height = tmp
    } else if (options?.aspectRatio === '1:1') {
      const size = Math.max(body.width as number, body.height as number)
      body.width = size
      body.height = size
    } else if (options?.aspectRatio === '4:3') {
      body.height = Math.round((body.width as number) * 3 / 4)
    } else if (options?.aspectRatio === '3:4') {
      const tmp = body.width as number
      body.width = Math.round(tmp * 3 / 4)
      body.height = tmp
    }

    _ulogInfo(`[AgnesVideo] Creating task: model=${modelId}, frames=${body.num_frames}, size=${body.width}x${body.height}`)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), VIDEO_CREATE_TIMEOUT_MS)

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        return {
          success: false,
          error: `Agnes Video create error: ${response.status} ${errorText.slice(0, 200)}`,
        }
      }

      const data = await response.json() as AgnesVideoTaskResponse
      const taskId = data.video_id || data.task_id || data.id
      const taskIdFallback = data.task_id || data.id

      if (!taskId) {
        return { success: false, error: 'Agnes Video API returned no task ID' }
      }

      return {
        success: true,
        async: true,
        requestId: taskId,
        externalId: `AGNES:VIDEO:${taskId}`,
        // 附加字段：用于轮询 fallback
        videoId: data.video_id || taskId,
        taskIdFallback: taskIdFallback || taskId,
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'Agnes Video create request timed out' }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Agnes Video create failed',
      }
    }
  }

  private async pollForResult(
    baseUrl: string,
    apiKey: string,
    taskId: string,
    externalId: string,
    modelId?: string,
    videoId?: string,
    taskIdFallback?: string,
  ): Promise<GenerateResult> {
    const startTime = Date.now()
    // 首选 video_id，fallback 用 task_id
    const primaryId = videoId || taskId
    const fallbackId = taskIdFallback || taskId
    // completed 状态但未拿到 URL 的连续次数（URL 可能延迟返回，最多重试 N 次）
    let completedWithoutUrlCount = 0
    const COMPLETED_WITHOUT_URL_MAX = 6  // 约 30 秒

    while (Date.now() - startTime < VIDEO_POLL_TIMEOUT_MS) {
      try {
        // 方式 1（推荐）：GET /agnesapi?video_id=<VIDEO_ID>
        let endpoint = `${baseUrl}${VIDEO_STATUS_ENDPOINT}?video_id=${primaryId}`
        if (modelId) {
          endpoint += `&model_name=${encodeURIComponent(modelId)}`
        }

        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        })

        if (response.ok) {
          const data = await response.json() as AgnesVideoStatusResponse

          if (data.status === 'completed') {
            let videoUrl = extractVideoUrl(data)
            if (!videoUrl) {
              // 方式 1 完成但无 URL：尝试旧版查询方式 2：GET /v1/videos/<TASK_ID>
              _ulogWarn(`[AgnesVideo] Method 1 completed without URL, trying legacy endpoint`)
              videoUrl = await this.queryLegacyEndpoint(baseUrl, apiKey, fallbackId)
            }
            if (!videoUrl) {
              // 两种方式均无 URL：不立即失败，继续轮询重试（URL 可能延迟返回）
              completedWithoutUrlCount++
              _ulogWarn(
                `[AgnesVideo] Completed without URL (attempt ${completedWithoutUrlCount}/${COMPLETED_WITHOUT_URL_MAX}), raw: ${JSON.stringify(data).slice(0, 300)}`,
              )
              if (completedWithoutUrlCount >= COMPLETED_WITHOUT_URL_MAX) {
                return {
                  success: false,
                  error: 'Agnes Video completed but no URL in response',
                  externalId,
                }
              }
              await this.sleep(VIDEO_POLL_INTERVAL_MS)
              continue
            }

            _ulogInfo(`[AgnesVideo] Completed: ${videoUrl}`)
            return {
              success: true,
              videoUrl,
              externalId,
            }
          }

          if (data.status === 'failed') {
            const errorMsg = data.error?.message || 'Unknown error'
            return {
              success: false,
              error: `Agnes Video failed: ${errorMsg}`,
              externalId,
            }
          }

          _ulogInfo(`[AgnesVideo] Status: ${data.status}, Progress: ${data.progress || 0}%`)
        } else {
          _ulogWarn(`[AgnesVideo] Poll HTTP ${response.status}, trying legacy endpoint`)
          // 方式 1 失败：尝试旧版查询方式 2
          const legacyData = await this.queryLegacyEndpointData(baseUrl, apiKey, fallbackId)
          if (legacyData) {
            if (legacyData.status === 'completed') {
              const videoUrl = extractVideoUrl(legacyData)
              if (videoUrl) {
                _ulogInfo(`[AgnesVideo] Completed (legacy): ${videoUrl}`)
                return {
                  success: true,
                  videoUrl,
                  externalId,
                }
              }
            } else if (legacyData.status === 'failed') {
              return {
                success: false,
                error: `Agnes Video failed: ${legacyData.error?.message || 'Unknown error'}`,
                externalId,
              }
            } else {
              _ulogInfo(`[AgnesVideo] Legacy status: ${legacyData.status}`)
            }
          }
        }
      } catch (error: unknown) {
        _ulogWarn(`[AgnesVideo] Poll error: ${error}`)
      }

      await this.sleep(VIDEO_POLL_INTERVAL_MS)
    }

    return {
      success: false,
      error: 'Agnes Video generation timed out',
      externalId,
      requestId: taskId,
      async: true,
    }
  }

  /**
   * 旧版查询方式：GET /v1/videos/<TASK_ID>
   * 返回视频 URL，未完成或无 URL 时返回 undefined
   */
  private async queryLegacyEndpoint(
    baseUrl: string,
    apiKey: string,
    taskId: string,
  ): Promise<string | undefined> {
    const data = await this.queryLegacyEndpointData(baseUrl, apiKey, taskId)
    if (!data) return undefined
    return extractVideoUrl(data)
  }

  /**
   * 旧版查询方式：GET /v1/videos/<TASK_ID>
   * 返回完整响应数据
   */
  private async queryLegacyEndpointData(
    baseUrl: string,
    apiKey: string,
    taskId: string,
  ): Promise<AgnesVideoStatusResponse | null> {
    try {
      const endpoint = `${baseUrl}/videos/${encodeURIComponent(taskId)}`
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      })
      if (!response.ok) return null
      return await response.json() as AgnesVideoStatusResponse
    } catch (error) {
      _ulogWarn(`[AgnesVideo] Legacy query error: ${error}`)
      return null
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

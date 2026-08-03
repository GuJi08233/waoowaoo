/**
 * StepFun (阶跃星辰) 生成器
 *
 * 支持：
 * - Step Image Edit 2 (文生图、图像编辑)
 * - StepAudio 2.5 TTS (语音合成)
 *
 * LLM 走 OpenAI 兼容协议 (chat/completions)，由 openai-compatible 路径处理。
 *
 * 文档: https://platform.stepfun.com/docs/llms.txt
 */

import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
import type {
  ImageGenerator,
  ImageGenerateParams,
  AudioGenerator,
  AudioGenerateParams,
  GenerateResult,
} from './base'
import { getProviderConfig } from '@/lib/api-config'

// ============================================================
// 常量
// ============================================================

const STEPFUN_BASE_URL = 'https://api.stepfun.com/step_plan/v1'
const IMAGE_GENERATE_ENDPOINT = '/images/generations'
const IMAGE_EDIT_ENDPOINT = '/images/edits'
const AUDIO_SPEECH_ENDPOINT = '/audio/speech'

// 默认超时
const IMAGE_TIMEOUT_MS = 120_000  // 2 分钟
const AUDIO_TIMEOUT_MS = 60_000  // 1 分钟

// ============================================================
// 工具函数
// ============================================================

function getBaseUrl(userId: string, providerId?: string): Promise<string> {
  return getProviderConfig(userId, providerId || 'stepfun').then(config => {
    return config?.baseUrl || STEPFUN_BASE_URL
  }).catch(() => STEPFUN_BASE_URL)
}

function getApiKey(userId: string, providerId?: string): Promise<string> {
  return getProviderConfig(userId, providerId || 'stepfun').then(config => {
    return config?.apiKey || ''
  }).catch(() => '')
}

// ============================================================
// StepFun Image Generator
// ============================================================

export class StepFunImageGenerator implements ImageGenerator {
  async generate(params: ImageGenerateParams): Promise<GenerateResult> {
    const { userId, prompt, referenceImages, options } = params
    const modelId = (options?.modelId as string) || 'step-image-edit-2'
    const providerId = (options?.provider as string) || 'stepfun'

    const [baseUrl, apiKey] = await Promise.all([
      getBaseUrl(userId, providerId),
      getApiKey(userId, providerId),
    ])

    if (!apiKey) {
      return { success: false, error: 'StepFun API Key not configured' }
    }

    // 文生图 vs 图像编辑
    const isEdit = !!referenceImages && referenceImages.length > 0
    const endpoint = isEdit
      ? `${baseUrl}${IMAGE_EDIT_ENDPOINT}`
      : `${baseUrl}${IMAGE_GENERATE_ENDPOINT}`

    _ulogInfo(`[StepFunImage] Generating: model=${modelId}, mode=${isEdit ? 'edit' : 'generate'}`)

    try {
      let response: Response

      if (isEdit) {
        // 图像编辑：multipart/form-data
        const formData = new FormData()
        formData.append('model', modelId)
        formData.append('prompt', prompt)
        formData.append('response_format', 'b64_json')
        for (const imageUrl of referenceImages!) {
          // 远程 URL 直接传递；Data URI 原样传递
          formData.append('image', imageUrl)
        }
        // 可选参数
        if (options?.cfgScale !== undefined) formData.append('cfg_scale', String(options.cfgScale))
        if (options?.steps !== undefined) formData.append('steps', String(options.steps))
        if (options?.seed !== undefined) formData.append('seed', String(options.seed))
        if (options?.textMode !== undefined) formData.append('text_mode', String(options.textMode))

        response = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: formData,
        }, IMAGE_TIMEOUT_MS)
      } else {
        // 文生图：JSON
        const body: Record<string, unknown> = {
          model: modelId,
          prompt,
          response_format: 'b64_json',
        }
        if (options?.cfgScale !== undefined) body.cfg_scale = options.cfgScale
        if (options?.steps !== undefined) body.steps = options.steps
        if (options?.seed !== undefined) body.seed = options.seed
        if (options?.textMode !== undefined) body.text_mode = options.textMode

        response = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }, IMAGE_TIMEOUT_MS)
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        _ulogError(`[StepFunImage] HTTP ${response.status}: ${errorText}`)
        return {
          success: false,
          error: `StepFun Image API error: ${response.status} ${errorText.slice(0, 200)}`,
        }
      }

      const data = await response.json() as {
        data?: Array<{ url?: string | null; b64_json?: string | null }>
      }

      if (!data.data || data.data.length === 0) {
        return { success: false, error: 'StepFun Image API returned empty result' }
      }

      const result = data.data[0]

      if (result.b64_json) {
        const base64Data = result.b64_json
        const dataUri = base64Data.startsWith('data:')
          ? base64Data
          : `data:image/png;base64,${base64Data}`
        _ulogInfo(`[StepFunImage] Success (base64)`)
        return { success: true, imageBase64: dataUri }
      }

      if (result.url) {
        _ulogInfo(`[StepFunImage] Success: ${result.url}`)
        return { success: true, imageUrl: result.url }
      }

      return { success: false, error: 'StepFun Image API returned no image data' }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'StepFun Image generation timed out' }
      }
      _ulogError(`[StepFunImage] Error: ${error}`)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'StepFun Image generation failed',
      }
    }
  }
}

// ============================================================
// StepFun Audio Generator (TTS)
// ============================================================

export class StepFunAudioGenerator implements AudioGenerator {
  async generate(params: AudioGenerateParams): Promise<GenerateResult> {
    const { userId, text, voice, rate, options } = params
    const modelId = (options?.modelId as string) || 'stepaudio-2.5-tts'
    const providerId = (options?.provider as string) || 'stepfun'

    const [baseUrl, apiKey] = await Promise.all([
      getBaseUrl(userId, providerId),
      getApiKey(userId, providerId),
    ])

    if (!apiKey) {
      return { success: false, error: 'StepFun API Key not configured' }
    }

    const endpoint = `${baseUrl}${AUDIO_SPEECH_ENDPOINT}`

    const body: Record<string, unknown> = {
      model: modelId,
      input: text,
    }

    // 音色
    if (voice) {
      body.voice = voice
    }

    // 语速（项目格式如 "+50%"）
    if (rate && typeof rate === 'string') {
      const match = rate.match(/([+-]?\d+(?:\.\d+)?)%/)
      if (match) {
        body.speed_ratio = 1 + Number.parseFloat(match[1]) / 100
      }
    }

    // 输出格式
    body.response_format = (options?.outputFormat as string) || 'mp3'

    // 可选：instruction
    if (options?.instruction && typeof options.instruction === 'string') {
      body.instruction = options.instruction
    }

    _ulogInfo(`[StepFunAudio] Generating TTS: model=${modelId}, voice=${voice || 'default'}`)

    try {
      const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }, AUDIO_TIMEOUT_MS)

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        _ulogError(`[StepFunAudio] HTTP ${response.status}: ${errorText}`)
        return {
          success: false,
          error: `StepFun TTS error: ${response.status} ${errorText.slice(0, 200)}`,
        }
      }

      // 直接返回音频字节流，上传到存储
      const arrayBuffer = await response.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)
      if (bytes.length === 0) {
        return { success: false, error: 'StepFun TTS returned empty audio' }
      }

      // 交给上层存储（audioUrl 由存储层处理）
      return {
        success: true,
        audioUrl: '',
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'StepFun TTS timed out' }
      }
      _ulogError(`[StepFunAudio] Error: ${error}`)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'StepFun TTS failed',
      }
    }
  }
}

// ============================================================
// 辅助函数
// ============================================================

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

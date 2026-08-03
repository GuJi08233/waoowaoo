/**
 * MiMo (小米) TTS 合成
 *
 * 文档: https://platform.xiaomimimo.com
 * - mimo-v2.5-tts          预置音色
 * - mimo-v2.5-tts-voicedesign 文字描述设计音色
 * - mimo-v2.5-tts-voiceclone  音频样本复刻音色
 *
 * 请求: POST /v1/chat/completions
 * - 目标文本放在 role=assistant 的 content
 * - 风格指令（可选）放在 role=user 的 content
 * - audio.voice 指定预置音色 ID 或 base64 音频样本
 * 响应: choices[0].message.audio.data (base64 音频)
 */

import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'

export const MIMO_BASE_URL = 'https://api.xiaomimimo.com/v1'

export interface MimoTTSInput {
  text: string
  voiceId?: string              // 预置音色 ID 或 base64 样本（voiceclone）
  styleInstruction?: string     // 自然语言风格指令（放入 user 消息）
  modelId?: string              // 默认 mimo-v2.5-tts
  apiKey: string
  baseUrl?: string
}

export interface MimoTTSResult {
  success: boolean
  audioData?: Buffer
  audioDuration?: number
  requestId?: string
  error?: string
}

function getWavDurationFromBuffer(buffer: Buffer): number {
  try {
    // WAV 文件: 采样率在 offset 24 (4 bytes), 数据块从 offset 12 的 "fmt " 后解析
    const sampleRate = buffer.readUInt32LE(24)
    const byteRate = buffer.readUInt32LE(28)
    if (byteRate === 0) return 0
    // 数据大小从 "data" 块读取
    let offset = 12
    let dataSize = 0
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4)
      const size = buffer.readUInt32LE(offset + 4)
      if (chunkId === 'data') {
        dataSize = size
        break
      }
      offset += 8 + size
    }
    if (dataSize === 0) return 0
    return dataSize / byteRate
  } catch {
    return 0
  }
}

export async function synthesizeWithMimoTTS(
  input: MimoTTSInput,
): Promise<MimoTTSResult> {
  if (!input.apiKey) {
    return { success: false, error: '请配置 MiMo API Key' }
  }

  const modelId = input.modelId || 'mimo-v2.5-tts'
  const baseURL = (input.baseUrl && input.baseUrl.trim()) || MIMO_BASE_URL
  const endpoint = `${baseURL.replace(/\/+$/, '')}/chat/completions`

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  // 风格指令（可选）：voicedesign 模型必填（音色描述）
  const styleInstruction = input.styleInstruction?.trim()
  if (styleInstruction) {
    messages.push({ role: 'user', content: styleInstruction })
  }
  // 目标文本必须放在 assistant 消息
  messages.push({ role: 'assistant', content: input.text })

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    audio: {
      format: 'wav',
    },
  }
  // 音色：预置音色 ID 或 base64 样本（voiceclone）
  if (input.voiceId?.trim()) {
    body.audio = {
      ...(body.audio as Record<string, unknown>),
      voice: input.voiceId.trim(),
    }
  }

  _ulogInfo(`[MiMoTTS] Synthesizing: model=${modelId}, voice=${input.voiceId || 'default'}`)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      _ulogError(`[MiMoTTS] HTTP ${response.status}: ${errorText}`)
      return {
        success: false,
        error: `MiMo TTS error: ${response.status} ${errorText.slice(0, 300)}`,
      }
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          audio?: { data?: string }
        }
      }>
      error?: { message?: string }
    }

    if (data.error?.message) {
      return { success: false, error: data.error.message }
    }

    const audioBase64 = data.choices?.[0]?.message?.audio?.data
    if (!audioBase64) {
      return { success: false, error: 'MiMo TTS 返回为空音频' }
    }

    const audioData = Buffer.from(audioBase64, 'base64')
    if (audioData.length === 0) {
      return { success: false, error: 'MiMo TTS 返回为空音频' }
    }

    _ulogInfo(`[MiMoTTS] Success: ${audioData.length} bytes`)
    return {
      success: true,
      audioData,
      audioDuration: getWavDurationFromBuffer(audioData),
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '网络请求失败'
    _ulogError(`[MiMoTTS] Error: ${message}`)
    return { success: false, error: message }
  }
}

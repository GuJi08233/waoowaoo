/**
 * MiMo (小米) 语音生成器
 *
 * 注意：语音生成主流程（generateVoiceLine）使用专门的 mimo 分支，
 * 此生成器用于 generateAudio API 的调用入口。
 */

import { BaseAudioGenerator, type AudioGenerateParams, type GenerateResult } from '../base'
import { getProviderConfig } from '@/lib/api-config'
import { synthesizeWithMimoTTS } from '@/lib/providers/mimo/tts'

export class MimoAudioGenerator extends BaseAudioGenerator {
  protected async doGenerate(params: AudioGenerateParams): Promise<GenerateResult> {
    const { userId, text, voice } = params
    const config = await getProviderConfig(userId, 'mimo')

    const result = await synthesizeWithMimoTTS({
      text,
      voiceId: voice,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    })
    if (!result.success) {
      return { success: false, error: result.error || 'MiMo TTS failed' }
    }
    return { success: true, audioUrl: '' }
  }
}

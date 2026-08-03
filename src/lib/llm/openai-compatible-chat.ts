/**
 * 通用 OpenAI 兼容 LLM 调用（用于 Agnes / StepFun 等官方提供商）
 *
 * 这些提供商的 LLM API 完全兼容 OpenAI Chat Completions 协议，
 * 但拥有独立的 baseUrl 和路由，因此单独封装。
 */

import OpenAI from 'openai'

export interface OpenAICompatibleChatParams {
  modelId: string
  messages: Array<{ role: string; content: string }>
  apiKey: string
  baseUrl: string
  temperature?: number
}

export async function completeOpenAICompatibleChat(
  params: OpenAICompatibleChatParams,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const client = new OpenAI({
    apiKey: params.apiKey,
    baseURL: params.baseUrl,
    timeout: 60_000,
  })
  const completion = await client.chat.completions.create({
    model: params.modelId,
    messages: params.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    temperature: params.temperature ?? 0.7,
  })
  return completion
}

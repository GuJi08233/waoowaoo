/**
 * 全局网络代理支持
 *
 * 通过环境变量 HTTP_PROXY / HTTPS_PROXY 配置代理。
 * 包装全局 fetch：匹配 NO_PROXY 的请求走直连，其余走代理。
 *
 * 用法：
 *   import { enableProxyIfConfigured } from '@/lib/proxy'
 *   enableProxyIfConfigured()
 *
 * 环境变量：
 *   HTTP_PROXY  - HTTP 代理地址，如 http://proxy:8080
 *   HTTPS_PROXY - HTTPS 代理地址（优先），如 http://proxy:8080
 *   NO_PROXY    - 不走代理的主机列表，逗号分隔，如 "localhost,127.0.0.1,mysql"
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { logInfo as _ulogInfo, logWarn as _ulogWarn } from '@/lib/logging/core'

// NO_PROXY 中常见的内网地址，避免内网流量走代理
const DEFAULT_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'mysql',
  'redis',
  'minio',
]

function parseNoProxy(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return DEFAULT_NO_PROXY
  const userEntries = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  // 合并默认项，去重
  return [...new Set([...DEFAULT_NO_PROXY, ...userEntries])]
}

function hostnameMatches(hostname: string, entry: string): boolean {
  const normalized = entry.toLowerCase()
  if (normalized === hostname) return true
  // 支持 *.example.com 通配符
  if (normalized.startsWith('*.')) {
    return hostname.endsWith(normalized.slice(1))
  }
  // 支持子域名匹配（example.com 匹配 sub.example.com）
  return hostname.endsWith(`.${normalized}`)
}

function shouldBypassProxy(url: string, noProxyList: string[]): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    return noProxyList.some((entry) => hostnameMatches(hostname, entry.trim()))
  } catch {
    return false
  }
}

let enabled = false

/**
 * 启用代理（幂等，重复调用无副作用）
 * @returns 是否成功启用代理
 */
export function enableProxyIfConfigured(): boolean {
  if (enabled) return true

  // HTTPS_PROXY 优先，回退到 HTTP_PROXY
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  if (!proxyUrl || !proxyUrl.trim()) {
    _ulogInfo('[Proxy] No HTTP_PROXY/HTTPS_PROXY configured, proxy disabled')
    return false
  }

  const noProxyList = parseNoProxy(process.env.NO_PROXY)

  let agent: ProxyAgent
  try {
    agent = new ProxyAgent({
      uri: proxyUrl.trim(),
      requestTls: {
        rejectUnauthorized: false,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    _ulogWarn(`[Proxy] Failed to create ProxyAgent (${message}), continuing without proxy`)
    return false
  }

  // 包装全局 fetch：NO_PROXY 匹配的请求直连，其余走代理
  const originalFetch = globalThis.fetch
  const patchedFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let url: string
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    } catch {
      return originalFetch(input, init)
    }
    if (shouldBypassProxy(url, noProxyList)) {
      return originalFetch(input, init)
    }
    // undici fetch 的 input 类型为 RequestInfo，需将 URL 转为 string
    const fetchInput: RequestInfo = input instanceof URL ? input.toString() : input
    // undici 的 Response 类型与全局 Response 不完全一致，需要类型转换
    return undiciFetch(fetchInput, { ...init, dispatcher: agent }) as unknown as Response
  }) as typeof fetch

  try {
    globalThis.fetch = patchedFetch
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    _ulogWarn(`[Proxy] Failed to patch fetch (${message}), continuing without proxy`)
    return false
  }

  enabled = true
  _ulogInfo(`[Proxy] Enabled via ${proxyUrl.trim()}, NO_PROXY=${noProxyList.join(',')}`)
  return true
}

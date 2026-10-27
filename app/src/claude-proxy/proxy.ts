import type express from 'express'
import { createReverseProxy } from '../shared/reverse-proxy.js'
import { tokenManager } from '../shared/oauth/token-manager.js'
import {
  applyClaudeAttributionToBody,
  computeClaudeAttribution,
  ensureDeviceId,
  type ClaudeAttributionConfig
} from '../shared/claude-attribution.js'

function getAttributionConfig(req: express.Request): ClaudeAttributionConfig | undefined {
  return req.app.get('claudeAttribution') as ClaudeAttributionConfig | undefined
}

function ensureAttributionDeviceId(): string {
  const credentials = tokenManager.getCredentials('anthropic')!
  return ensureDeviceId(credentials, () => tokenManager.updateCredentials('anthropic', credentials))
}

/** Keep the caller's own betas but guarantee the OAuth beta is present. */
function mergeOAuthBeta(req: express.Request): Record<string, string> {
  const raw = req.headers['anthropic-beta']
  const clientBeta = Array.isArray(raw) ? raw.join(',') : raw
  if (clientBeta && !clientBeta.includes('oauth-2025-04-20')) {
    return { 'anthropic-beta': `${clientBeta},oauth-2025-04-20` }
  }
  return {}
}

export const claudeProxyHandler = createReverseProxy({
  providerId: 'anthropic',
  upstreamBaseUrl: 'https://api.anthropic.com',
  stripPrefix: '/claude',
  requestIdPrefix: 'claude',

  // Real Claude Code always calls the messages endpoint with ?beta=true
  mapUpstreamPath(method, upstreamPath) {
    if (method !== 'POST') return upstreamPath
    const [path, query] = upstreamPath.split('?')
    if (path !== '/v1/messages') return upstreamPath
    const params = new URLSearchParams(query ?? '')
    if (params.get('beta') !== 'true') params.set('beta', 'true')
    return `${path}?${params.toString()}`
  },

  modifyBody(body: Record<string, unknown>, req: express.Request) {
    const config = getAttributionConfig(req)
    if (config?.enabled === false) return body

    const credentials = tokenManager.getCredentials('anthropic')
    if (!credentials) return body

    const deviceId = ensureAttributionDeviceId()
    const attribution = computeClaudeAttribution(req.headers, body, credentials, deviceId, config)
    return applyClaudeAttributionToBody(body, attribution, credentials, deviceId, config)
  },

  extraHeaders(req: express.Request) {
    const config = getAttributionConfig(req)
    if (config?.enabled === false) return mergeOAuthBeta(req)

    const credentials = tokenManager.getCredentials('anthropic')
    if (!credentials) return mergeOAuthBeta(req)

    const deviceId = ensureAttributionDeviceId()
    const attribution = computeClaudeAttribution(
      req.headers,
      req.body as Record<string, unknown> | undefined,
      credentials,
      deviceId,
      config
    )
    // A confirmed Claude Code client brings its own full fingerprint; only the
    // OAuth beta merge still applies.
    if (attribution.confirmedClient) return mergeOAuthBeta(req)
    return attribution.headers
  },

  // Surface Claude subscription limit rejections (5h / 7d usage windows)
  transformErrorResponse(status, headers, bodyText) {
    if (status !== 429) return bodyText
    const unified = headers.get('anthropic-ratelimit-unified-status')
    const fiveHour = headers.get('anthropic-ratelimit-unified-5h-status')
    const sevenDay = headers.get('anthropic-ratelimit-unified-7d-status')
    const reset = headers.get('anthropic-ratelimit-unified-reset')
    if (![unified, fiveHour, sevenDay].includes('rejected')) return bodyText

    try {
      const parsed = JSON.parse(bodyText) as { error?: Record<string, unknown> }
      if (parsed.error) {
        parsed.error.subscription_limits = {
          unified,
          five_hour: fiveHour,
          seven_day: sevenDay,
          ...(reset ? { resets_at: Number(reset) } : {})
        }
        return JSON.stringify(parsed)
      }
    } catch {
      // Non-JSON error body: relay unchanged
    }
    return bodyText
  }
})

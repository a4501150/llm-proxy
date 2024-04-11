import { createReverseProxy } from '../shared/reverse-proxy.js'
import { tokenManager } from '../shared/oauth/token-manager.js'
import { buildMetadataUserId } from '../shared/oauth/providers/anthropic.js'

export const claudeProxyHandler = createReverseProxy({
  providerId: 'anthropic',
  upstreamBaseUrl: 'https://api.anthropic.com',
  stripPrefix: '/claude',
  requestIdPrefix: 'claude',

  modifyBody(body: any, req: any) {
    const configDeviceId = req.app?.get('deviceId') as string | undefined
    if (!configDeviceId) return body

    const credentials = tokenManager.getCredentials('anthropic')
    if (!credentials) return body

    const rawUserId = body?.metadata?.user_id as string | undefined
    const userIdMatch = rawUserId?.match(/^user_([^_]+)_account_(.*)_session_(.+)$/)
    const sessionId = userIdMatch?.[3] || `req-${Date.now()}`

    const overrideUserId = buildMetadataUserId(credentials, configDeviceId, sessionId)
    if (overrideUserId) {
      return { ...body, metadata: { ...body.metadata, user_id: overrideUserId } }
    }
    return body
  },

  extraHeaders(req: any) {
    // Merge anthropic-beta: the provider's buildAuthHeaders sets oauth-2025-04-20,
    // but the client may also send anthropic-beta that needs to be preserved
    const clientBeta = req.headers['anthropic-beta'] as string | undefined
    if (clientBeta && !clientBeta.includes('oauth-2025-04-20')) {
      return { 'anthropic-beta': `${clientBeta},oauth-2025-04-20` }
    }
    return {} as Record<string, string>
  }
})

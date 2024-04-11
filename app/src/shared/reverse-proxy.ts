import type express from 'express'
import { Readable } from 'stream'
import { logger } from '../logger.js'
import { validateAuthentication } from './auth.js'
import type { OAuthProviderId, ProviderCredentials } from './oauth/types.js'

// Headers to strip from the client request before forwarding
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'x-api-key',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'accept-encoding'
])

// Headers to strip from the upstream response before sending to client
const STRIP_RESPONSE_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'keep-alive',
  'content-encoding',
  'content-length'
])

export interface ReverseProxyConfig {
  /** Provider ID for token resolution */
  providerId: OAuthProviderId
  /** Upstream base URL (e.g., 'https://api.openai.com') */
  upstreamBaseUrl: string
  /** URL path prefix to strip (e.g., '/openai'). The rest maps to upstream. */
  stripPrefix: string
  /** Optional: modify request body before forwarding */
  modifyBody?: (body: any, req: express.Request) => any
  /** Optional: add extra headers beyond the provider's auth headers */
  extraHeaders?: (req: express.Request, credentials: ProviderCredentials) => Record<string, string>
  /** Prefix for request IDs (e.g., 'claude', 'openai', 'google') */
  requestIdPrefix: string
}

function getClientIP(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

export function createReverseProxy(config: ReverseProxyConfig): express.RequestHandler {
  const stripPrefixRegex = new RegExp(`^${config.stripPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

  return async (req: express.Request, res: express.Response, _next: express.NextFunction): Promise<void> => {
    const startTime = Date.now()
    const requestId = `${config.requestIdPrefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
    const clientIP = getClientIP(req)

    res.setHeader('X-Request-Id', requestId)

    // Lazy import to avoid circular dependencies
    const { tokenManager } = await import('./oauth/token-manager.js')

    const upstreamPath = req.originalUrl.replace(stripPrefixRegex, '')
    const upstreamUrl = `${config.upstreamBaseUrl}${upstreamPath}`

    logger.info(`${config.requestIdPrefix} proxy request`, {
      requestId,
      clientIP,
      method: req.method,
      path: upstreamPath
    })

    try {
      // Step 1: Authenticate client to proxy
      const authResult = validateAuthentication(req, requestId, clientIP)
      if (!authResult.success) {
        res.status(authResult.statusCode).json({
          type: 'error',
          error: { type: 'authentication_error', message: authResult.error }
        })
        return
      }

      // Step 2: Get OAuth/API key token
      const resolved = await tokenManager.getToken(config.providerId)
      const credentials = tokenManager.getCredentials(config.providerId)

      // Step 3: Build upstream headers
      const upstreamHeaders: Record<string, string> = {}

      // Forward client headers (except auth and hop-by-hop)
      for (const [key, value] of Object.entries(req.headers)) {
        if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue
        if (typeof value === 'string') {
          upstreamHeaders[key] = value
        }
      }

      // Apply provider-specific auth headers
      const provider = tokenManager.getProvider(config.providerId)
      const authHeaders = credentials
        ? provider.buildAuthHeaders(resolved.token, credentials)
        : { authorization: `Bearer ${resolved.token}` }
      Object.assign(upstreamHeaders, authHeaders)

      // Apply extra headers if configured
      if (config.extraHeaders && credentials) {
        Object.assign(upstreamHeaders, config.extraHeaders(req, credentials))
      }

      // Step 4: Build request body
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body
      let body: string | undefined
      if (hasBody) {
        const finalBody = config.modifyBody ? config.modifyBody(req.body, req) : req.body
        body = JSON.stringify(finalBody)
      }

      const fetchOptions: RequestInit = {
        method: req.method,
        headers: upstreamHeaders,
        ...(body ? { body } : {})
      }

      logger.debug(`Forwarding to ${config.providerId} API`, {
        requestId,
        url: upstreamUrl,
        method: req.method,
        authMode: resolved.type,
        user: authResult.username
      })

      let upstream = await fetch(upstreamUrl, fetchOptions)

      // Step 5: Retry once on 401/403 if using OAuth
      if ((upstream.status === 401 || upstream.status === 403) && resolved.type === 'oauth') {
        const errorBody = await upstream.text()
        logger.warn(`Received auth error from ${config.providerId} API`, {
          requestId,
          status: upstream.status,
          path: upstreamPath,
          errorBody: errorBody.slice(0, 1000)
        })

        try {
          await tokenManager.refreshToken(config.providerId, resolved.token)
          const refreshed = await tokenManager.getToken(config.providerId)
          const refreshedCredentials = tokenManager.getCredentials(config.providerId)

          // Rebuild auth headers with refreshed token
          const refreshedAuthHeaders = refreshedCredentials
            ? provider.buildAuthHeaders(refreshed.token, refreshedCredentials)
            : { authorization: `Bearer ${refreshed.token}` }
          Object.assign(upstreamHeaders, refreshedAuthHeaders)

          logger.info('Retrying request with refreshed OAuth token', {
            requestId,
            provider: config.providerId
          })
          upstream = await fetch(upstreamUrl, { ...fetchOptions, headers: upstreamHeaders })

          if (upstream.status === 401 || upstream.status === 403) {
            const retryErrorBody = await upstream.text()
            logger.error('Retry also failed with auth error', {
              requestId,
              status: upstream.status,
              errorBody: retryErrorBody.slice(0, 1000)
            })
            if (!res.headersSent) {
              res.status(upstream.status).json(JSON.parse(retryErrorBody || '{}'))
            }
            return
          }
        } catch (refreshErr) {
          const refreshMsg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr)
          const flowState = tokenManager.getFlowState(config.providerId)
          logger.error('Token refresh failed, re-authentication required', {
            requestId,
            provider: config.providerId,
            error: refreshMsg,
            authorizeUrl: flowState?.authorizeUrl
          })

          if (!res.headersSent) {
            res.status(401).json({
              type: 'error',
              error: {
                type: 'authentication_error',
                message: `Token refresh failed: ${refreshMsg}. Re-authenticate via the authorization URL.`,
                ...(flowState?.authorizeUrl ? { authorize_url: flowState.authorizeUrl } : {})
              }
            })
          }
          return
        }
      }

      // Step 6: Forward response headers
      for (const [key, value] of upstream.headers.entries()) {
        if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
        res.setHeader(key, value)
      }
      res.status(upstream.status)

      // Step 7: Stream or send response body
      if (!upstream.body) {
        res.end()
      } else {
        const reader = upstream.body.getReader()
        const nodeStream = new Readable({
          async read() {
            try {
              const { done, value } = await reader.read()
              if (done) {
                this.push(null)
              } else {
                this.push(Buffer.from(value))
              }
            } catch (err) {
              this.destroy(err as Error)
            }
          }
        })

        nodeStream.on('error', (err) => {
          logger.error('Stream error', { requestId, error: err.message })
          if (!res.writableEnded) {
            res.end()
          }
        })

        nodeStream.pipe(res)

        res.on('close', () => {
          reader.cancel().catch(() => {})
          nodeStream.destroy()
        })

        res.on('finish', () => {
          const duration = Date.now() - startTime
          logger.info(`${config.requestIdPrefix} proxy request completed`, {
            requestId,
            duration: `${duration}ms`,
            path: upstreamPath,
            status: upstream.status
          })
        })
        return
      }

      const duration = Date.now() - startTime
      logger.info(`${config.requestIdPrefix} proxy request completed`, {
        requestId,
        duration: `${duration}ms`,
        path: upstreamPath,
        status: upstream.status
      })
    } catch (err: unknown) {
      const duration = Date.now() - startTime
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`${config.requestIdPrefix} proxy error`, {
        requestId,
        error: message,
        duration: `${duration}ms`
      })

      if (!res.headersSent) {
        res.status(502).json({
          type: 'error',
          error: { type: 'api_error', message: `Proxy error: ${message}` }
        })
      }
    }
  }
}

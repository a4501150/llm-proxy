import type express from 'express'
import path from 'path'
import { Readable } from 'stream'
import { GoogleAuth } from 'google-auth-library'
import type { Application } from '../declarations.js'
import { logger } from '../logger.js'
import { validateAuthentication } from '../shared/auth.js'

// Ensure GOOGLE_APPLICATION_CREDENTIALS is set (same default as vertex/vertex-ai-proxy.ts)
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve('config/vertex-ai.json')
}

// Cached GoogleAuth instance — reuses the same auth client across requests
const auth = new GoogleAuth({
  scopes: 'https://www.googleapis.com/auth/cloud-platform'
})
const authClientPromise = auth.getClient()

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

// Extract location from a Vertex AI path like /v1/projects/{project}/locations/{location}/...
const LOCATION_REGEX = /\/locations\/([^/]+)/

function getClientIP(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

async function getAccessToken(): Promise<string> {
  const client = await authClientPromise
  const tokenResponse = await client.getAccessToken()
  if (!tokenResponse.token) {
    throw new Error('Failed to obtain access token from service account')
  }
  return tokenResponse.token
}

async function vertexAIProxyHandler(req: express.Request, res: express.Response): Promise<void> {
  const startTime = Date.now()
  const requestId = `vertexai-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
  const clientIP = getClientIP(req)

  res.setHeader('X-Request-Id', requestId)

  // Strip the /vertex-ai prefix to get the upstream path
  const upstreamPath = req.originalUrl.replace(/^\/vertex-ai/, '')

  logger.info('vertex-ai proxy request', {
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

    // Step 2: Extract location from path to build dynamic hostname
    const locationMatch = upstreamPath.match(LOCATION_REGEX)
    if (!locationMatch) {
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'Could not determine location from URL path. Expected format: /v1/projects/{project}/locations/{location}/...'
        }
      })
      return
    }
    const location = locationMatch[1]
    const upstreamUrl = `https://${location}-aiplatform.googleapis.com${upstreamPath}`

    // Step 3: Get service account access token
    let token = await getAccessToken()

    // Step 4: Build upstream headers
    const upstreamHeaders: Record<string, string> = {
      authorization: `Bearer ${token}`
    }

    for (const [key, value] of Object.entries(req.headers)) {
      if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue
      if (typeof value === 'string') {
        upstreamHeaders[key] = value
      }
    }

    // Step 5: Build request body
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body
    const body = hasBody ? JSON.stringify(req.body) : undefined

    const fetchOptions: RequestInit = {
      method: req.method,
      headers: upstreamHeaders,
      ...(body ? { body } : {})
    }

    logger.debug('Forwarding to Vertex AI', {
      requestId,
      url: upstreamUrl,
      method: req.method,
      user: authResult.username
    })

    let upstream = await fetch(upstreamUrl, fetchOptions)

    // Step 6: Retry once on 401 (token may have expired)
    if (upstream.status === 401) {
      const errorBody = await upstream.text()
      logger.warn('Received 401 from Vertex AI, refreshing access token', {
        requestId,
        errorBody: errorBody.slice(0, 500)
      })

      try {
        // Force a new token by getting a fresh client
        const client = await auth.getClient()
        const refreshed = await client.getAccessToken()
        if (!refreshed.token) {
          throw new Error('Token refresh returned empty token')
        }
        token = refreshed.token
        upstreamHeaders['authorization'] = `Bearer ${token}`

        upstream = await fetch(upstreamUrl, { ...fetchOptions, headers: upstreamHeaders })
      } catch (refreshErr) {
        const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr)
        logger.error('Token refresh failed', { requestId, error: msg })
        if (!res.headersSent) {
          res.status(401).json({
            type: 'error',
            error: { type: 'authentication_error', message: `Token refresh failed: ${msg}` }
          })
        }
        return
      }
    }

    // Step 7: Forward response headers
    for (const [key, value] of upstream.headers.entries()) {
      if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
      res.setHeader(key, value)
    }
    res.status(upstream.status)

    // Step 8: Stream or send response body
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
        logger.info('vertex-ai proxy request completed', {
          requestId,
          duration: `${duration}ms`,
          path: upstreamPath,
          status: upstream.status
        })
      })
      return
    }

    const duration = Date.now() - startTime
    logger.info('vertex-ai proxy request completed', {
      requestId,
      duration: `${duration}ms`,
      path: upstreamPath,
      status: upstream.status
    })
  } catch (err: unknown) {
    const duration = Date.now() - startTime
    const message = err instanceof Error ? err.message : String(err)
    logger.error('vertex-ai proxy error', {
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

export const setupVertexAIDirectProxy = (app: Application): void => {
  app.use('/vertex-ai', vertexAIProxyHandler)
}

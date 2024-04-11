import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../logger'
import { validateAuthentication } from '../shared/auth'
import { tokenManager } from '../shared/oauth/token-manager.js'
import type { ResolvedToken } from '../shared/oauth/types.js'
import { setupSSEHeaders } from '../shared/sse-utils'
import { getErrorDetails } from '../shared/errors'

// --- Client management ---

let cachedClient: Anthropic | null = null
let cachedAuthMode: 'api_key' | 'oauth' | null = null

function getOrCreateClient(resolved: ResolvedToken): Anthropic {
  if (cachedClient && cachedAuthMode === resolved.type) {
    // Update token if OAuth (may have been refreshed)
    if (resolved.type === 'oauth') {
      cachedClient.authToken = resolved.token
    }
    return cachedClient
  }

  if (resolved.type === 'api_key') {
    cachedClient = new Anthropic({ apiKey: resolved.token })
  } else {
    cachedClient = new Anthropic({
      apiKey: '',
      authToken: resolved.token,
      defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' }
    })
  }
  cachedAuthMode = resolved.type

  logger.info('Created Anthropic direct client', { authMode: resolved.type })
  return cachedClient
}

// --- Helpers ---

function generateRequestId(): string {
  return `claude-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

function getClientIP(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

// --- Handler ---

/**
 * Handler for POST /claude/v1/messages
 * Near-passthrough to Anthropic Messages API using OAuth credentials.
 */
export async function claudeMessagesHandler(req: express.Request, res: express.Response): Promise<void> {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(req)

  res.setHeader('X-Request-Id', requestId)

  logger.info('Claude messages request', {
    requestId,
    clientIP,
    model: req.body?.model
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

    // Step 2: Validate request
    const body = req.body
    if (!body.model || !body.messages) {
      res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'model and messages are required' }
      })
      return
    }

    // Step 3: Get OAuth/API key token
    let resolved: ResolvedToken
    try {
      resolved = await tokenManager.getToken('anthropic')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('Failed to get Anthropic token', { requestId, error: msg })
      res.status(503).json({
        type: 'error',
        error: { type: 'authentication_error', message: msg }
      })
      return
    }

    // Step 4: Get client
    const client = getOrCreateClient(resolved)

    // Step 5: Forward request
    const isStreaming = body.stream === true

    logger.info('Forwarding to Anthropic API', {
      requestId,
      model: body.model,
      streaming: isStreaming,
      authMode: resolved.type,
      user: authResult.username
    })

    if (isStreaming) {
      await handleStreaming(client, body, res, requestId)
    } else {
      await handleNonStreaming(client, body, res, requestId)
    }

    const duration = Date.now() - startTime
    logger.info('Claude messages request completed', {
      requestId,
      duration: `${duration}ms`,
      model: body.model
    })
  } catch (err: unknown) {
    const duration = Date.now() - startTime
    const details = getErrorDetails(err)
    logger.error('Claude messages error', {
      requestId,
      error: details.message,
      status: details.status,
      duration: `${duration}ms`
    })

    if (!res.headersSent) {
      const statusCode = details.status || 500
      res.status(statusCode).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: details.errorMessage || details.message || 'Internal server error'
        }
      })
    }
  }
}

async function handleStreaming(
  client: Anthropic,
  body: Record<string, unknown>,
  res: express.Response,
  requestId: string
): Promise<void> {
  setupSSEHeaders(res)

  const stream = await client.messages.stream(body as Parameters<typeof client.messages.stream>[0])

  try {
    for await (const event of stream) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    res.end()
  } catch (err: unknown) {
    const details = getErrorDetails(err)
    logger.error('Stream error', { requestId, error: details.message })
    if (!res.writableEnded) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: details.message } })}\n\n`
      )
      res.end()
    }
    throw err
  }
}

async function handleNonStreaming(
  client: Anthropic,
  body: Record<string, unknown>,
  res: express.Response,
  requestId: string
): Promise<void> {
  const message = await client.messages.create({
    ...body,
    stream: false
  } as Parameters<typeof client.messages.create>[0])

  res.setHeader('Content-Type', 'application/json')
  res.json(message)
}

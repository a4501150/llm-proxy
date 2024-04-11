import AnthropicVertex from '@anthropic-ai/vertex-sdk'
import Anthropic from '@anthropic-ai/sdk'
import express from 'express'
import { logger } from '../logger'
import { validateAuthentication } from '../shared/auth'
import { setupSSEHeaders } from '../shared/sse-utils'
import { createClientCache } from '../shared/client-cache'
import { sharedAgent } from '../shared/connection-pool'
import { getErrorDetails } from '../shared/errors'
import { tokenManager } from '../shared/oauth/token-manager.js'
import type { ResolvedToken } from '../shared/oauth/types.js'
import type { LLMProvider } from '../openai/translators/types'
import { VALID_PROVIDERS } from '../openai/translators/types'
import { openaiMessagesTranslator } from './translators/openai-translator'
import { geminiMessagesTranslator } from './translators/gemini-translator'

// AnthropicVertex client cache keyed by project:location
const vertexClientCache = createClientCache<AnthropicVertex>(
  'AnthropicVertex-messages',
  (project, location) =>
    new AnthropicVertex({
      projectId: project,
      region: location,
      fetchOptions: {
        dispatcher: sharedAgent,
        keepalive: true
      }
    })
)

// Direct Anthropic client (for provider: 'claude')
let directClient: Anthropic | null = null
let directAuthMode: 'api_key' | 'oauth' | null = null

function getOrCreateDirectClient(resolved: ResolvedToken): Anthropic {
  if (directClient && directAuthMode === resolved.type) {
    if (resolved.type === 'oauth') directClient.authToken = resolved.token
    return directClient
  }
  if (resolved.type === 'api_key') {
    directClient = new Anthropic({ apiKey: resolved.token })
  } else {
    directClient = new Anthropic({
      apiKey: '',
      authToken: resolved.token,
      defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' }
    })
  }
  directAuthMode = resolved.type
  logger.info('Created Anthropic direct client', { authMode: resolved.type })
  return directClient
}

function generateRequestId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

function getClientIP(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

/**
 * Handler for POST /v1/messages
 * Accepts Anthropic Messages API format and routes through multiple providers.
 * Provider is selected via X-LLM-Provider header.
 */
export async function anthropicMessagesHandler(req: express.Request, res: express.Response): Promise<void> {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(req)

  res.setHeader('X-Request-Id', requestId)

  logger.info('Anthropic messages request', {
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

    // Step 2: Validate provider header
    const providerHeader = req.headers['x-llm-provider'] as string | undefined
    if (!providerHeader || !VALID_PROVIDERS.includes(providerHeader as LLMProvider)) {
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `X-LLM-Provider header is required. Valid values: ${VALID_PROVIDERS.join(', ')}`
        }
      })
      return
    }
    const provider = providerHeader as LLMProvider

    // Step 3: Validate request
    const body = req.body
    if (!body.model || !body.messages) {
      res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'model and messages are required' }
      })
      return
    }

    // Step 4: Route to provider
    const isStreaming = body.stream === true

    logger.info('Forwarding messages request', {
      requestId,
      model: body.model,
      streaming: isStreaming,
      provider,
      user: authResult.username
    })

    if (provider === 'vertex-ai') {
      const vertexConfig = req.app.get('vertex')
      if (!vertexConfig?.project || !vertexConfig?.location) {
        logger.error('Vertex AI config missing', { requestId })
        res.status(500).json({
          type: 'error',
          error: { type: 'api_error', message: 'Vertex AI project/location not configured' }
        })
        return
      }
      const client = vertexClientCache.get(vertexConfig.project, vertexConfig.location)
      if (isStreaming) await handleVertexStreaming(client, body, res, requestId)
      else await handleVertexNonStreaming(client, body, res, requestId)
    } else if (provider === 'claude') {
      const resolved = await tokenManager.getToken('anthropic')
      const client = getOrCreateDirectClient(resolved)
      if (isStreaming) await handleDirectStreaming(client, body, res, requestId)
      else await handleDirectNonStreaming(client, body, res, requestId)
    } else if (provider === 'openai') {
      if (isStreaming) await openaiMessagesTranslator.executeStreamRequest(body, res, requestId)
      else await openaiMessagesTranslator.executeRequest(body, res, requestId)
    } else if (provider === 'google') {
      if (isStreaming) await geminiMessagesTranslator.executeStreamRequest(body, res, requestId)
      else await geminiMessagesTranslator.executeRequest(body, res, requestId)
    }

    const duration = Date.now() - startTime
    logger.info('Anthropic messages request completed', {
      requestId,
      duration: `${duration}ms`,
      model: body.model
    })
  } catch (err: unknown) {
    const duration = Date.now() - startTime
    const details = getErrorDetails(err)
    logger.error('Anthropic messages error', {
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

async function handleVertexStreaming(
  client: AnthropicVertex,
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

async function handleVertexNonStreaming(
  client: AnthropicVertex,
  body: Record<string, unknown>,
  res: express.Response,
  _requestId: string
): Promise<void> {
  const message = await client.messages.create({
    ...body,
    stream: false
  } as Parameters<typeof client.messages.create>[0])

  res.setHeader('Content-Type', 'application/json')
  res.json(message)
}

async function handleDirectStreaming(
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
    logger.error('Direct stream error', { requestId, error: details.message })
    if (!res.writableEnded) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: details.message } })}\n\n`
      )
      res.end()
    }
    throw err
  }
}

async function handleDirectNonStreaming(
  client: Anthropic,
  body: Record<string, unknown>,
  res: express.Response,
  _requestId: string
): Promise<void> {
  const message = await client.messages.create({
    ...body,
    stream: false
  } as Parameters<typeof client.messages.create>[0])

  res.setHeader('Content-Type', 'application/json')
  res.json(message)
}

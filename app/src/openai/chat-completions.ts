/**
 * OpenAI-compatible Chat Completions Handler
 * POST /v1/chat/completions
 */

import express from 'express'
import { logger } from '../logger'
import { validateAuthentication } from '../shared/auth'
import { getErrorDetails } from '../shared/errors'
import { claudeTranslator } from './translators/claude-translator'
import { geminiTranslator } from './translators/gemini-translator'
import { openaiTranslator } from './translators/openai-translator'
import type { Translator, TranslatorConfig } from './translators/types'
import { VALID_PROVIDERS } from './translators/types'
import type { LLMProvider } from './translators/types'
import type { OpenAIChatRequest, OpenAIErrorResponse } from './types'
import { generateRequestId, getClientIP, mapStatusToErrorType } from './utils'

// Register all available translators (used for vertex-ai model-prefix routing)
const translators: Translator[] = [claudeTranslator, geminiTranslator]

/**
 * Send an OpenAI-format error response
 */
function sendErrorResponse(res: express.Response, statusCode: number, message: string, code?: string): void {
  const errorResponse: OpenAIErrorResponse = {
    error: {
      message,
      type: mapStatusToErrorType(statusCode),
      param: null,
      code: code || null
    }
  }
  res.status(statusCode).json(errorResponse)
}

/**
 * Validate the request body
 */
function validateRequest(
  body: unknown
): { valid: true; request: OpenAIChatRequest } | { valid: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body is required' }
  }

  const req = body as Record<string, unknown>

  if (!req.model || typeof req.model !== 'string') {
    return { valid: false, error: 'model is required and must be a string' }
  }

  if (!req.messages || !Array.isArray(req.messages)) {
    return { valid: false, error: 'messages is required and must be an array' }
  }

  if (req.messages.length === 0) {
    return { valid: false, error: 'messages array cannot be empty' }
  }

  // Basic message validation
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i] as Record<string, unknown>
    if (!msg.role || typeof msg.role !== 'string') {
      return { valid: false, error: `messages[${i}].role is required` }
    }
    if (!['system', 'user', 'assistant', 'tool'].includes(msg.role)) {
      return { valid: false, error: `messages[${i}].role must be one of: system, user, assistant, tool` }
    }
    // Content is required for user and system messages
    if ((msg.role === 'user' || msg.role === 'system') && msg.content === undefined) {
      return { valid: false, error: `messages[${i}].content is required for ${msg.role} messages` }
    }
    // tool_call_id is required for tool messages
    if (msg.role === 'tool' && !msg.tool_call_id) {
      return { valid: false, error: `messages[${i}].tool_call_id is required for tool messages` }
    }
  }

  return { valid: true, request: body as OpenAIChatRequest }
}

/**
 * Resolve the translator for a model
 */
function resolveTranslator(model: string): Translator | undefined {
  return translators.find((t) => t.matchesModel(model))
}

/**
 * Main chat completions handler
 */
export async function chatCompletionsHandler(req: express.Request, res: express.Response): Promise<void> {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(req)

  // Set request ID header
  res.setHeader('X-Request-Id', requestId)

  logger.info('OpenAI chat completions request', {
    requestId,
    clientIP,
    method: req.method,
    path: req.path
  })

  try {
    // Step 1: Authenticate
    const authResult = validateAuthentication(req, requestId, clientIP)
    if (!authResult.success) {
      sendErrorResponse(res, authResult.statusCode, authResult.error)
      return
    }

    logger.debug('Request authenticated', {
      requestId,
      username: authResult.username
    })

    // Step 2: Validate provider header
    const providerHeader = req.headers['x-llm-provider'] as string | undefined
    if (!providerHeader || !VALID_PROVIDERS.includes(providerHeader as LLMProvider)) {
      sendErrorResponse(
        res,
        400,
        `X-LLM-Provider header is required. Valid values: ${VALID_PROVIDERS.join(', ')}`
      )
      return
    }
    const provider = providerHeader as LLMProvider

    // Step 3: Validate request body
    const validation = validateRequest(req.body)
    if (!validation.valid) {
      sendErrorResponse(res, 400, validation.error)
      return
    }

    const request = validation.request

    // Step 4: Resolve translator based on provider
    let translator: Translator | undefined
    if (provider === 'openai') {
      translator = openaiTranslator
    } else if (provider === 'claude') {
      translator = claudeTranslator
    } else if (provider === 'google') {
      translator = geminiTranslator
    } else {
      // vertex-ai: use model-prefix routing
      translator = resolveTranslator(request.model)
    }

    if (!translator) {
      const supportedPrefixes = translators.map((t) => t.name).join(', ')
      sendErrorResponse(
        res,
        400,
        `Unsupported model: ${request.model}. Supported model prefixes for vertex-ai: ${supportedPrefixes}`,
        'model_not_found'
      )
      return
    }

    // Step 5: Build config
    let config: TranslatorConfig
    if (provider === 'vertex-ai') {
      const vertexConfig = req.app.get('vertex')
      if (!vertexConfig || !vertexConfig.project || !vertexConfig.location) {
        sendErrorResponse(res, 500, 'Server configuration error: Vertex AI project/location not configured')
        return
      }
      config = {
        provider,
        vertexProject: vertexConfig.project,
        vertexLocation: vertexConfig.location
      }
    } else {
      config = { provider }
    }

    logger.debug('Delegating to translator', {
      requestId,
      provider,
      translator: translator.name,
      model: request.model,
      streaming: !!request.stream,
      messageCount: request.messages.length,
      hasTools: !!request.tools
    })

    // Step 6: Execute request (streaming or non-streaming)
    if (request.stream) {
      await translator.executeStreamRequest(request, config, res, requestId)
    } else {
      const response = await translator.executeRequest(request, config, requestId)
      res.json(response)
    }

    // Log successful completion
    const duration = Date.now() - startTime
    logger.info('OpenAI chat completions completed', {
      requestId,
      duration: `${duration}ms`,
      model: request.model,
      translator: translator.name,
      streaming: !!request.stream
    })
  } catch (err: unknown) {
    const duration = Date.now() - startTime
    const details = getErrorDetails(err)

    logger.error('OpenAI chat completions error', {
      requestId,
      error: details.message,
      stack: details.stack,
      status: details.status,
      duration: `${duration}ms`
    })

    // Don't send error if headers already sent (streaming)
    if (!res.headersSent) {
      const statusCode = details.status || 500
      sendErrorResponse(res, statusCode, details.message || 'Internal server error')
    }
  }
}

/**
 * Claude Translator - converts OpenAI format to/from Claude API format
 */

import Anthropic from '@anthropic-ai/sdk'
import AnthropicVertex from '@anthropic-ai/vertex-sdk'
import type {
  MessageCreateParams,
  MessageCreateParamsNonStreaming,
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  Tool,
  ToolChoice
} from '@anthropic-ai/sdk/resources/messages'
import express from 'express'
import { Translator, TranslatorConfig } from './types'
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIChatMessage,
  OpenAIToolCall,
  OpenAITool,
  OpenAIToolChoice,
  OpenAIChatChunk,
  OpenAIToolCallDelta
} from '../types'
import {
  generateCompletionId,
  generateToolCallId,
  getCurrentTimestamp,
  mapClaudeFinishReason
} from '../utils'
import { logger } from '../../logger'
import { sharedAgent } from '../../shared/connection-pool'
import { setupSSEHeaders } from '../../shared/sse-utils'
import { createClientCache } from '../../shared/client-cache'
import { DEFAULT_MAX_TOKENS } from '../../shared/constants'
import { getErrorDetails } from '../../shared/errors'
import { tokenManager } from '../../shared/oauth/token-manager.js'
import type { ResolvedToken } from '../../shared/oauth/types.js'

// Client cache for Vertex AI - reuse the same pattern as claude-provider
const vertexClientCache = createClientCache<AnthropicVertex>(
  'AnthropicVertex-OpenAI',
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

// Direct Anthropic client cache (for provider: 'claude')
let directClient: Anthropic | null = null
let directAuthMode: 'api_key' | 'oauth' | null = null

function getOrCreateDirectClient(resolved: ResolvedToken): Anthropic {
  if (directClient && directAuthMode === resolved.type) {
    if (resolved.type === 'oauth') {
      directClient.authToken = resolved.token
    }
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

  logger.info('Created Anthropic direct client (claude-translator)', { authMode: resolved.type })
  return directClient
}

/**
 * Convert OpenAI messages to Claude format
 */
function convertMessages(messages: OpenAIChatMessage[]): {
  system: string | undefined
  claudeMessages: MessageParam[]
} {
  let system: string | undefined
  const claudeMessages: MessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Combine multiple system messages
      system = system ? `${system}\n${msg.content}` : msg.content
    } else if (msg.role === 'user') {
      // User messages: convert content to Claude format
      if (typeof msg.content === 'string') {
        claudeMessages.push({ role: 'user', content: msg.content })
      } else {
        // Array of content parts
        const contentBlocks: ContentBlockParam[] = msg.content.map((part) => {
          if (part.type === 'text') {
            return { type: 'text' as const, text: part.text }
          } else if (part.type === 'image_url') {
            // Handle image URLs - Claude expects base64 or URL
            const url = part.image_url.url
            if (url.startsWith('data:')) {
              // Base64 encoded image
              const matches = url.match(/^data:([^;]+);base64,(.+)$/)
              if (matches) {
                return {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: matches[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                    data: matches[2]
                  }
                }
              }
            }
            // URL-based image
            return {
              type: 'image' as const,
              source: {
                type: 'url' as const,
                url: url
              }
            }
          }
          // Fallback for unknown types
          return { type: 'text' as const, text: '' }
        })
        claudeMessages.push({ role: 'user', content: contentBlocks })
      }
    } else if (msg.role === 'assistant') {
      // Assistant messages: handle tool_calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const contentBlocks: ContentBlockParam[] = []

        // Add text content if present
        if (msg.content) {
          contentBlocks.push({ type: 'text' as const, text: msg.content })
        }

        // Convert tool_calls to tool_use blocks
        for (const toolCall of msg.tool_calls) {
          contentBlocks.push({
            type: 'tool_use' as const,
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments)
          })
        }

        claudeMessages.push({ role: 'assistant', content: contentBlocks })
      } else {
        claudeMessages.push({ role: 'assistant', content: msg.content || '' })
      }
    } else if (msg.role === 'tool') {
      // Tool result messages: convert to user message with tool_result block
      const toolResultBlock: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content
      }
      claudeMessages.push({ role: 'user', content: [toolResultBlock] })
    }
  }

  return { system, claudeMessages }
}

/**
 * Convert OpenAI tools to Claude format
 */
function convertTools(tools: OpenAITool[] | undefined): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description || '',
    input_schema: (tool.function.parameters || { type: 'object', properties: {} }) as Tool['input_schema']
  }))
}

/**
 * Convert OpenAI tool_choice to Claude format
 */
function convertToolChoice(toolChoice: OpenAIToolChoice | undefined): ToolChoice | undefined {
  if (!toolChoice) return undefined

  if (toolChoice === 'auto') {
    return { type: 'auto' }
  }
  if (toolChoice === 'none') {
    return { type: 'none' }
  }
  if (toolChoice === 'required') {
    return { type: 'any' }
  }
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return { type: 'tool', name: toolChoice.function.name }
  }

  return undefined
}

/**
 * Convert Claude tool_use blocks to OpenAI tool_calls
 */
function convertToolUseToToolCalls(
  content: Array<{ type: string; id?: string; name?: string; input?: unknown }>
): OpenAIToolCall[] {
  const toolCalls: OpenAIToolCall[] = []

  for (const block of content) {
    if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      })
    }
  }

  return toolCalls
}

/**
 * Extract text content from Claude response
 */
function extractTextContent(content: Array<{ type: string; text?: string }>): string | null {
  const textBlocks = content.filter((block) => block.type === 'text' && block.text)
  if (textBlocks.length === 0) return null
  return textBlocks.map((block) => block.text).join('')
}

export const claudeTranslator: Translator = {
  name: 'claude',

  matchesModel(model: string): boolean {
    return model.startsWith('claude')
  },

  async executeRequest(
    request: OpenAIChatRequest,
    config: TranslatorConfig,
    requestId: string
  ): Promise<OpenAIChatResponse> {
    let client: AnthropicVertex | Anthropic
    if (config.provider === 'claude') {
      const resolved = await tokenManager.getToken('anthropic')
      client = getOrCreateDirectClient(resolved)
    } else {
      client = vertexClientCache.get(config.vertexProject!, config.vertexLocation!)
    }
    const { system, claudeMessages } = convertMessages(request.messages)

    const tools = convertTools(request.tools)
    const toolChoice = convertToolChoice(request.tool_choice)

    const requestParams: MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.max_tokens || DEFAULT_MAX_TOKENS,
      messages: claudeMessages,
      stream: false,
      ...(system && { system }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.top_p !== undefined && { top_p: request.top_p }),
      ...(request.stop && { stop_sequences: Array.isArray(request.stop) ? request.stop : [request.stop] }),
      ...(tools && { tools }),
      ...(toolChoice && { tool_choice: toolChoice })
    }

    logger.debug('Claude translator: executing non-streaming request', {
      requestId,
      model: request.model,
      messageCount: claudeMessages.length,
      hasTools: !!request.tools
    })

    const message = await client.messages.create(requestParams)

    // Convert response to OpenAI format
    const content = Array.isArray(message.content) ? message.content : []
    const textContent = extractTextContent(content as Array<{ type: string; text?: string }>)
    const toolCalls = convertToolUseToToolCalls(
      content as Array<{ type: string; id?: string; name?: string; input?: unknown }>
    )

    const response: OpenAIChatResponse = {
      id: generateCompletionId(),
      object: 'chat.completion',
      created: getCurrentTimestamp(),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent,
            ...(toolCalls.length > 0 && { tool_calls: toolCalls })
          },
          finish_reason: mapClaudeFinishReason(message.stop_reason)
        }
      ],
      usage: {
        prompt_tokens: message.usage?.input_tokens || 0,
        completion_tokens: message.usage?.output_tokens || 0,
        total_tokens: (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0)
      }
    }

    logger.debug('Claude translator: request completed', {
      requestId,
      stopReason: message.stop_reason,
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens
    })

    return response
  },

  async executeStreamRequest(
    request: OpenAIChatRequest,
    config: TranslatorConfig,
    res: express.Response,
    requestId: string
  ): Promise<void> {
    let client: AnthropicVertex | Anthropic
    if (config.provider === 'claude') {
      const resolved = await tokenManager.getToken('anthropic')
      client = getOrCreateDirectClient(resolved)
    } else {
      client = vertexClientCache.get(config.vertexProject!, config.vertexLocation!)
    }
    const { system, claudeMessages } = convertMessages(request.messages)

    const tools = convertTools(request.tools)
    const toolChoice = convertToolChoice(request.tool_choice)

    const requestParams: MessageCreateParams = {
      model: request.model,
      max_tokens: request.max_tokens || DEFAULT_MAX_TOKENS,
      messages: claudeMessages,
      ...(system && { system }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.top_p !== undefined && { top_p: request.top_p }),
      ...(request.stop && { stop_sequences: Array.isArray(request.stop) ? request.stop : [request.stop] }),
      ...(tools && { tools }),
      ...(toolChoice && { tool_choice: toolChoice })
    }

    logger.debug('Claude translator: executing streaming request', {
      requestId,
      model: request.model,
      messageCount: claudeMessages.length,
      hasTools: !!request.tools
    })

    const stream = await client.messages.stream(requestParams)

    // Set up SSE headers
    setupSSEHeaders(res)

    const completionId = generateCompletionId()
    const created = getCurrentTimestamp()
    let sentRole = false
    let finishReason: string | null = null

    // Track tool calls: map from Claude block index to output tool call index
    const blockIndexToToolIndex: Map<number, number> = new Map()
    let toolCallIndex = 0

    try {
      for await (const event of stream) {
        const eventType = (event as { type: string }).type

        if (eventType === 'message_start') {
          // Send initial chunk with role
          const chunk: OpenAIChatChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant' },
                finish_reason: null
              }
            ]
          }
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          sentRole = true
        } else if (eventType === 'content_block_start') {
          const blockEvent = event as {
            type: string
            index: number
            content_block: { type: string; id?: string; name?: string }
          }
          if (blockEvent.content_block.type === 'tool_use') {
            // Start of a tool call - map block index to output tool call index
            const toolId = blockEvent.content_block.id || generateToolCallId()
            const toolName = blockEvent.content_block.name || ''
            blockIndexToToolIndex.set(blockEvent.index, toolCallIndex)

            // Send tool call start
            const toolCallDelta: OpenAIToolCallDelta = {
              index: toolCallIndex,
              id: toolId,
              type: 'function',
              function: { name: toolName, arguments: '' }
            }
            const chunk: OpenAIChatChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [toolCallDelta] },
                  finish_reason: null
                }
              ]
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            toolCallIndex++
          }
        } else if (eventType === 'content_block_delta') {
          const deltaEvent = event as {
            type: string
            index: number
            delta: { type: string; text?: string; partial_json?: string }
          }

          if (deltaEvent.delta.type === 'text_delta' && deltaEvent.delta.text) {
            // Text content
            const chunk: OpenAIChatChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: { content: deltaEvent.delta.text },
                  finish_reason: null
                }
              ]
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          } else if (deltaEvent.delta.type === 'input_json_delta' && deltaEvent.delta.partial_json) {
            // Tool call arguments (streamed JSON)
            const tcIndex = blockIndexToToolIndex.get(deltaEvent.index)
            if (tcIndex !== undefined) {
              const toolCallDelta: OpenAIToolCallDelta = {
                index: tcIndex,
                function: { arguments: deltaEvent.delta.partial_json }
              }
              const chunk: OpenAIChatChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: request.model,
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [toolCallDelta] },
                    finish_reason: null
                  }
                ]
              }
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
          }
        } else if (eventType === 'message_delta') {
          const messageDelta = event as {
            type: string
            delta: { stop_reason?: string }
            usage?: { output_tokens: number }
          }
          if (messageDelta.delta.stop_reason) {
            finishReason = messageDelta.delta.stop_reason
          }
        }
      }

      // Send final chunk with finish_reason
      const finalChunk: OpenAIChatChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: mapClaudeFinishReason(finishReason)
          }
        ]
      }
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)

      // Send [DONE] marker
      res.write('data: [DONE]\n\n')
      res.end()

      logger.debug('Claude translator: streaming completed', {
        requestId,
        finishReason
      })
    } catch (err: unknown) {
      const details = getErrorDetails(err)
      logger.error('Claude translator: streaming error', {
        requestId,
        error: details.message
      })

      // Try to send error in SSE format if headers already sent
      if (res.headersSent) {
        const errorChunk = {
          error: {
            message: details.message,
            type: 'server_error'
          }
        }
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
      throw err
    }
  }
}

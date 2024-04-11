/**
 * Gemini Messages Translator
 * Converts Anthropic Messages format to/from Gemini format using @google/genai SDK.
 * Sends requests via Google GenAI and converts responses back to Anthropic format.
 */

import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai'
import type { Content, Part, Tool, ToolConfig } from '@google/genai'
import type { MessagesTranslator } from './types'
import express from 'express'
import { logger } from '../../logger'
import { setupSSEHeaders } from '../../shared/sse-utils'
import { getErrorDetails } from '../../shared/errors'
import { tokenManager } from '../../shared/oauth/token-manager.js'

// -- Type helpers for Anthropic message format --

interface AnthropicTextBlock {
  type: 'text'
  text: string
}

interface AnthropicImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: unknown
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

type AnthropicContentBlock =
  AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock | AnthropicToolUseBlock

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicSystemBlock {
  type: 'text'
  text: string
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

interface AnthropicToolChoice {
  type: string
  name?: string
}

// -- Gemini response part type --

interface GeminiResponsePart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
}

// -- Client management --

let cachedClient: GoogleGenAI | null = null

async function getClient(): Promise<GoogleGenAI> {
  if (cachedClient) return cachedClient
  const resolved = await tokenManager.getToken('google')
  cachedClient = new GoogleGenAI({ apiKey: resolved.token })
  logger.info('Created Google GenAI direct client (gemini-messages-translator)')
  return cachedClient
}

// -- Helpers --

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

function generateToolUseId(): string {
  return `toolu_${Math.random().toString(36).substring(2, 11)}`
}

function mapGeminiFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'STOP':
      return 'end_turn'
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'SAFETY':
    case 'RECITATION':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

function safeJsonParse(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string') {
    if (content && typeof content === 'object') return content as Record<string, unknown>
    return { result: String(content) }
  }
  try {
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return { result: content }
  }
}

// -- Conversion --

function convertToGemini(body: Record<string, unknown>): {
  contents: Content[]
  systemInstruction: string | undefined
  tools: Tool[] | undefined
  toolConfig: ToolConfig | undefined
  config: Record<string, unknown>
} {
  // System instruction
  let systemInstruction: string | undefined
  const system = body.system as string | AnthropicSystemBlock[] | undefined
  if (system) {
    if (typeof system === 'string') {
      systemInstruction = system
    } else if (Array.isArray(system)) {
      systemInstruction = system
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
    }
  }

  // Convert messages to Gemini contents
  const contents: Content[] = []
  const anthropicMessages = (body.messages as AnthropicMessage[]) || []

  for (const msg of anthropicMessages) {
    if (msg.role === 'user') {
      const parts: Part[] = []

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text })
          } else if (block.type === 'image') {
            const imgBlock = block as AnthropicImageBlock
            if (imgBlock.source.type === 'base64') {
              parts.push({
                inlineData: {
                  mimeType: imgBlock.source.media_type,
                  data: imgBlock.source.data
                }
              })
            }
          } else if (block.type === 'tool_result') {
            const trBlock = block as AnthropicToolResultBlock
            parts.push({
              functionResponse: {
                name: trBlock.tool_use_id,
                response: safeJsonParse(trBlock.content)
              }
            })
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role: 'user', parts })
      }
    } else if (msg.role === 'assistant') {
      const parts: Part[] = []

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text })
          } else if (block.type === 'tool_use') {
            const tuBlock = block as AnthropicToolUseBlock
            parts.push({
              functionCall: {
                name: tuBlock.name,
                args: tuBlock.input
              }
            })
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role: 'model', parts })
      }
    }
  }

  // Convert tools
  let tools: Tool[] | undefined
  const anthropicTools = body.tools as AnthropicTool[] | undefined
  if (anthropicTools && anthropicTools.length > 0) {
    tools = [
      {
        functionDeclarations: anthropicTools.map((t) => ({
          name: t.name,
          description: t.description,
          ...(t.input_schema && {
            parametersJsonSchema: t.input_schema as Record<string, unknown>
          })
        }))
      }
    ]
  }

  // Convert tool_choice
  let toolConfig: ToolConfig | undefined
  const toolChoice = body.tool_choice as AnthropicToolChoice | undefined
  if (toolChoice && tools) {
    switch (toolChoice.type) {
      case 'auto':
        toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } }
        break
      case 'any':
        toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } }
        break
      case 'none':
        toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } }
        break
      case 'tool':
        toolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: toolChoice.name ? [toolChoice.name] : undefined
          }
        }
        break
    }
  }

  // Build config
  const config: Record<string, unknown> = {}
  if (body.max_tokens !== undefined) config.maxOutputTokens = body.max_tokens
  if (body.temperature !== undefined) config.temperature = body.temperature
  if (body.top_p !== undefined) config.topP = body.top_p

  return { contents, systemInstruction, tools, toolConfig, config }
}

/**
 * Convert Gemini response to Anthropic Messages format
 */
function convertFromGemini(
  response: {
    candidates?: { content?: { parts?: GeminiResponsePart[] }; finishReason?: string }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  },
  model: string
): Record<string, unknown> {
  const candidate = response.candidates?.[0]
  const parts = candidate?.content?.parts || []
  const usage = response.usageMetadata

  const content: Record<string, unknown>[] = []

  for (const part of parts) {
    if (part.text !== undefined) {
      content.push({ type: 'text', text: part.text })
    }
    if (part.functionCall) {
      content.push({
        type: 'tool_use',
        id: generateToolUseId(),
        name: part.functionCall.name,
        input: part.functionCall.args || {}
      })
    }
  }

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapGeminiFinishReason(candidate?.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.promptTokenCount || 0,
      output_tokens: usage?.candidatesTokenCount || 0
    }
  }
}

// -- Translator implementation --

export const geminiMessagesTranslator: MessagesTranslator = {
  name: 'gemini-messages',

  async executeRequest(
    body: Record<string, unknown>,
    res: express.Response,
    requestId: string
  ): Promise<void> {
    const { contents, systemInstruction, tools, toolConfig, config } = convertToGemini(body)
    const model = String(body.model)

    logger.debug('Gemini messages translator: executing non-streaming request', {
      requestId,
      model,
      messageCount: contents.length,
      hasTools: !!tools,
      hasSystemInstruction: !!systemInstruction
    })

    const client = await getClient()

    const response = await client.models.generateContent({
      model,
      contents,
      config: {
        ...config,
        ...(tools && { tools }),
        ...(toolConfig && { toolConfig })
      },
      ...(systemInstruction && { systemInstruction })
    })

    const anthropicResponse = convertFromGemini(
      response as {
        candidates?: { content?: { parts?: GeminiResponsePart[] }; finishReason?: string }[]
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
      },
      model
    )

    res.setHeader('Content-Type', 'application/json')
    res.json(anthropicResponse)

    logger.debug('Gemini messages translator: request completed', { requestId })
  },

  async executeStreamRequest(
    body: Record<string, unknown>,
    res: express.Response,
    requestId: string
  ): Promise<void> {
    const { contents, systemInstruction, tools, toolConfig, config } = convertToGemini(body)
    const model = String(body.model)

    logger.debug('Gemini messages translator: executing streaming request', {
      requestId,
      model,
      messageCount: contents.length,
      hasTools: !!tools
    })

    const client = await getClient()

    const stream = await client.models.generateContentStream({
      model,
      contents,
      config: {
        ...config,
        ...(tools && { tools }),
        ...(toolConfig && { toolConfig })
      },
      ...(systemInstruction && { systemInstruction })
    })

    setupSSEHeaders(res)

    const messageId = generateMessageId()

    // Emit message_start
    res.write(
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      })}\n\n`
    )

    let blockIndex = 0
    let currentBlockType: 'text' | 'tool_use' | null = null
    let finishReason: string | null = null

    try {
      for await (const chunk of stream) {
        const candidate = chunk.candidates?.[0]
        const parts = (candidate?.content?.parts as GeminiResponsePart[] | undefined) || []

        for (const part of parts) {
          if (part.text !== undefined) {
            // Text content
            if (currentBlockType !== 'text') {
              if (currentBlockType !== null) {
                res.write(
                  `event: content_block_stop\ndata: ${JSON.stringify({
                    type: 'content_block_stop',
                    index: blockIndex
                  })}\n\n`
                )
                blockIndex++
              }
              currentBlockType = 'text'
              res.write(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'text', text: '' }
                })}\n\n`
              )
            }
            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: part.text }
              })}\n\n`
            )
          }

          if (part.functionCall) {
            // Close previous block
            if (currentBlockType !== null) {
              res.write(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: blockIndex
                })}\n\n`
              )
              blockIndex++
            }
            currentBlockType = 'tool_use'

            const toolId = generateToolUseId()
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: blockIndex,
                content_block: {
                  type: 'tool_use',
                  id: toolId,
                  name: part.functionCall.name
                }
              })}\n\n`
            )

            // Emit the full arguments as a single delta
            const argsJson = JSON.stringify(part.functionCall.args || {})
            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'input_json_delta', partial_json: argsJson }
              })}\n\n`
            )
          }
        }

        if (candidate?.finishReason) {
          finishReason = candidate.finishReason as string
        }
      }

      // Close current block
      if (currentBlockType !== null) {
        res.write(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: blockIndex
          })}\n\n`
        )
      }

      // Emit final events
      const stopReason = mapGeminiFinishReason(finishReason)
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 0 }
        })}\n\n`
      )
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      res.end()

      logger.debug('Gemini messages translator: streaming completed', {
        requestId,
        finishReason
      })
    } catch (err: unknown) {
      const details = getErrorDetails(err)
      logger.error('Gemini messages translator: streaming error', {
        requestId,
        error: details.message
      })

      if (!res.writableEnded) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: { message: details.message }
          })}\n\n`
        )
        res.end()
      }
      throw err
    }
  }
}

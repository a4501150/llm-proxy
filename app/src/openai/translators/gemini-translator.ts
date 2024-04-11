/**
 * Gemini Translator - converts OpenAI format to/from Gemini API format
 */

import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai'
import type { Content, Part, Tool, ToolConfig } from '@google/genai'
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
  OpenAIToolCallDelta,
  OpenAIContentPart
} from '../types'
import {
  generateCompletionId,
  generateToolCallId,
  getCurrentTimestamp,
  mapGeminiFinishReason
} from '../utils'
import { logger } from '../../logger'
import { setupSSEHeaders } from '../../shared/sse-utils'
import { createClientCache } from '../../shared/client-cache'
import { DEFAULT_MAX_TOKENS } from '../../shared/constants'
import { getErrorDetails } from '../../shared/errors'
import { tokenManager } from '../../shared/oauth/token-manager.js'

// Type for Gemini response parts (for extracting data)
interface GeminiResponsePart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
}

// Client cache for Vertex AI - reuse the same pattern as gemini-provider
const vertexClientCache = createClientCache<GoogleGenAI>(
  'GoogleGenAI-OpenAI',
  (project, location) =>
    new GoogleGenAI({
      vertexai: true,
      project,
      location
    })
)

// Direct Google GenAI client (for provider: 'google')
let directClient: GoogleGenAI | null = null

async function getDirectClient(): Promise<GoogleGenAI> {
  if (directClient) return directClient
  const resolved = await tokenManager.getToken('google')
  directClient = new GoogleGenAI({ apiKey: resolved.token })
  logger.info('Created Google GenAI direct client (gemini-translator)')
  return directClient
}

/**
 * Convert OpenAI messages to Gemini format
 */
function convertMessages(messages: OpenAIChatMessage[]): {
  systemInstruction: string | undefined
  contents: Content[]
} {
  let systemInstruction: string | undefined
  const contents: Content[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Combine multiple system messages
      systemInstruction = systemInstruction ? `${systemInstruction}\n${msg.content}` : msg.content
    } else if (msg.role === 'user') {
      const parts: Part[] = []

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content })
      } else {
        // Array of content parts
        for (const part of msg.content as OpenAIContentPart[]) {
          if (part.type === 'text') {
            parts.push({ text: part.text })
          } else if (part.type === 'image_url') {
            const url = part.image_url.url
            if (url.startsWith('data:')) {
              // Base64 encoded image
              const matches = url.match(/^data:([^;]+);base64,(.+)$/)
              if (matches) {
                parts.push({
                  inlineData: {
                    mimeType: matches[1],
                    data: matches[2]
                  }
                })
              }
            }
            // Note: Gemini doesn't support URL-based images directly, only inline data
          }
        }
      }

      contents.push({ role: 'user', parts })
    } else if (msg.role === 'assistant') {
      const parts: Part[] = []

      if (msg.content) {
        parts.push({ text: msg.content })
      }

      // Handle tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments)
            }
          })
        }
      }

      contents.push({ role: 'model', parts })
    } else if (msg.role === 'tool') {
      // Tool response - needs to be a user message with functionResponse
      // Note: In Gemini, function responses should follow the model's function call
      // We need to find the tool call this is responding to
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: msg.tool_call_id, // Use tool_call_id as the function name reference
              response: safeJsonParse(msg.content) as Record<string, unknown>
            }
          }
        ]
      })
    }
  }

  return { systemInstruction, contents }
}

/**
 * Safely parse JSON, returning the original string wrapped in an object if parsing fails
 */
function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return { result: content }
  }
}

/**
 * Convert OpenAI tools to Gemini format
 */
function convertTools(tools: OpenAITool[] | undefined): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        ...(tool.function.parameters && {
          parametersJsonSchema: tool.function.parameters as Record<string, unknown>
        })
      }))
    }
  ]
}

/**
 * Convert OpenAI tool_choice to Gemini toolConfig
 */
function convertToolChoice(
  toolChoice: OpenAIToolChoice | undefined,
  tools: OpenAITool[] | undefined
): ToolConfig | undefined {
  if (!tools || tools.length === 0) return undefined
  if (!toolChoice) return undefined

  if (toolChoice === 'auto') {
    return {
      functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO }
    }
  }
  if (toolChoice === 'none') {
    return {
      functionCallingConfig: { mode: FunctionCallingConfigMode.NONE }
    }
  }
  if (toolChoice === 'required') {
    return {
      functionCallingConfig: { mode: FunctionCallingConfigMode.ANY }
    }
  }
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.ANY,
        allowedFunctionNames: [toolChoice.function.name]
      }
    }
  }

  return undefined
}

/**
 * Extract text content from Gemini response parts
 */
function extractTextFromParts(parts: GeminiResponsePart[] | undefined): string | null {
  if (!parts) return null
  const textParts = parts.filter((part) => part.text !== undefined)
  if (textParts.length === 0) return null
  return textParts.map((part) => part.text).join('')
}

/**
 * Convert Gemini function calls to OpenAI tool_calls
 */
function convertFunctionCallsToToolCalls(parts: GeminiResponsePart[] | undefined): OpenAIToolCall[] {
  if (!parts) return []

  const toolCalls: OpenAIToolCall[] = []
  for (const part of parts) {
    if (part.functionCall) {
      toolCalls.push({
        id: generateToolCallId(),
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      })
    }
  }
  return toolCalls
}

export const geminiTranslator: Translator = {
  name: 'gemini',

  matchesModel(model: string): boolean {
    return model.startsWith('gemini')
  },

  async executeRequest(
    request: OpenAIChatRequest,
    config: TranslatorConfig,
    requestId: string
  ): Promise<OpenAIChatResponse> {
    let client: GoogleGenAI
    if (config.provider === 'google') {
      client = await getDirectClient()
    } else {
      client = vertexClientCache.get(config.vertexProject!, config.vertexLocation!)
    }
    const { systemInstruction, contents } = convertMessages(request.messages)
    const tools = convertTools(request.tools)
    const toolConfig = convertToolChoice(request.tool_choice, request.tools)

    logger.debug('Gemini translator: executing non-streaming request', {
      requestId,
      model: request.model,
      messageCount: contents.length,
      hasTools: !!tools,
      hasSystemInstruction: !!systemInstruction
    })

    const response = await client.models.generateContent({
      model: request.model,
      contents,
      config: {
        maxOutputTokens: request.max_tokens || DEFAULT_MAX_TOKENS,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.top_p !== undefined && { topP: request.top_p }),
        ...(tools && { tools }),
        ...(toolConfig && { toolConfig })
      },
      ...(systemInstruction && { systemInstruction })
    })

    // Extract response data
    const candidate = response.candidates?.[0]
    const parts = candidate?.content?.parts as GeminiResponsePart[] | undefined
    const textContent = extractTextFromParts(parts)
    const toolCalls = convertFunctionCallsToToolCalls(parts)

    // Get usage from response
    const usage = response.usageMetadata

    const openAIResponse: OpenAIChatResponse = {
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
          finish_reason: mapGeminiFinishReason(candidate?.finishReason)
        }
      ],
      usage: {
        prompt_tokens: usage?.promptTokenCount || 0,
        completion_tokens: usage?.candidatesTokenCount || 0,
        total_tokens: usage?.totalTokenCount || 0
      }
    }

    logger.debug('Gemini translator: request completed', {
      requestId,
      finishReason: candidate?.finishReason,
      promptTokens: usage?.promptTokenCount,
      completionTokens: usage?.candidatesTokenCount
    })

    return openAIResponse
  },

  async executeStreamRequest(
    request: OpenAIChatRequest,
    config: TranslatorConfig,
    res: express.Response,
    requestId: string
  ): Promise<void> {
    let client: GoogleGenAI
    if (config.provider === 'google') {
      client = await getDirectClient()
    } else {
      client = vertexClientCache.get(config.vertexProject!, config.vertexLocation!)
    }
    const { systemInstruction, contents } = convertMessages(request.messages)
    const tools = convertTools(request.tools)
    const toolConfig = convertToolChoice(request.tool_choice, request.tools)

    logger.debug('Gemini translator: executing streaming request', {
      requestId,
      model: request.model,
      messageCount: contents.length,
      hasTools: !!tools
    })

    const stream = await client.models.generateContentStream({
      model: request.model,
      contents,
      config: {
        maxOutputTokens: request.max_tokens || DEFAULT_MAX_TOKENS,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.top_p !== undefined && { topP: request.top_p }),
        ...(tools && { tools }),
        ...(toolConfig && { toolConfig })
      },
      ...(systemInstruction && { systemInstruction })
    })

    // Set up SSE headers
    setupSSEHeaders(res)

    const completionId = generateCompletionId()
    const created = getCurrentTimestamp()
    let sentRole = false
    let finishReason: string | null = null
    let toolCallIndex = 0

    try {
      for await (const chunk of stream) {
        const candidate = chunk.candidates?.[0]
        const parts = candidate?.content?.parts as GeminiResponsePart[] | undefined

        // Send role in first chunk
        if (!sentRole) {
          const roleChunk: OpenAIChatChunk = {
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
          res.write(`data: ${JSON.stringify(roleChunk)}\n\n`)
          sentRole = true
        }

        if (parts) {
          for (const part of parts) {
            if (part.text) {
              // Text content
              const textChunk: OpenAIChatChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: request.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: part.text },
                    finish_reason: null
                  }
                ]
              }
              res.write(`data: ${JSON.stringify(textChunk)}\n\n`)
            } else if (part.functionCall) {
              // Function call
              const toolCallDelta: OpenAIToolCallDelta = {
                index: toolCallIndex,
                id: generateToolCallId(),
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {})
                }
              }
              const toolChunk: OpenAIChatChunk = {
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
              res.write(`data: ${JSON.stringify(toolChunk)}\n\n`)
              toolCallIndex++
            }
          }
        }

        if (candidate?.finishReason) {
          finishReason = candidate.finishReason
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
            finish_reason: mapGeminiFinishReason(finishReason)
          }
        ]
      }
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)

      // Send [DONE] marker
      res.write('data: [DONE]\n\n')
      res.end()

      logger.debug('Gemini translator: streaming completed', {
        requestId,
        finishReason
      })
    } catch (err: unknown) {
      const details = getErrorDetails(err)
      logger.error('Gemini translator: streaming error', {
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

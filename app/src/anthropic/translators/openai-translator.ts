/**
 * OpenAI Messages Translator
 * Converts Anthropic Messages format to/from OpenAI Chat Completions format.
 * Sends requests to api.openai.com and converts responses back to Anthropic format.
 */

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
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }
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

// -- OpenAI types --

interface OpenAIMessage {
  role: string
  content?: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAIContentPart {
  type: string
  text?: string
  image_url?: { url: string }
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

interface OpenAIChoice {
  index: number
  message: {
    role: string
    content: string | null
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: string | null
}

interface OpenAIResponse {
  id: string
  object: string
  created: number
  model: string
  choices: OpenAIChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// -- Conversion helpers --

function mapFinishReason(reason: string | null): string {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    default:
      return 'end_turn'
  }
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Convert Anthropic Messages request body to OpenAI Chat Completions format
 */
function convertToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const messages: OpenAIMessage[] = []

  // Handle system message
  const system = body.system as string | AnthropicSystemBlock[] | undefined
  if (system) {
    let systemText: string
    if (typeof system === 'string') {
      systemText = system
    } else if (Array.isArray(system)) {
      systemText = system
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
    } else {
      systemText = String(system)
    }
    messages.push({ role: 'system', content: systemText })
  }

  // Convert messages
  const anthropicMessages = (body.messages as AnthropicMessage[]) || []
  for (const msg of anthropicMessages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const parts: OpenAIContentPart[] = []
        const toolResults: OpenAIMessage[] = []

        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'image') {
            const imgBlock = block as AnthropicImageBlock
            if (imgBlock.source.type === 'base64') {
              parts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}`
                }
              })
            } else if (imgBlock.source.type === 'url') {
              parts.push({
                type: 'image_url',
                image_url: { url: imgBlock.source.url }
              })
            }
          } else if (block.type === 'tool_result') {
            const trBlock = block as AnthropicToolResultBlock
            const content =
              typeof trBlock.content === 'string' ? trBlock.content : JSON.stringify(trBlock.content)
            toolResults.push({
              role: 'tool',
              tool_call_id: trBlock.tool_use_id,
              content
            })
          }
        }

        // Tool results become separate messages; other content blocks go in user message
        if (parts.length > 0) {
          messages.push({ role: 'user', content: parts })
        }
        for (const tr of toolResults) {
          messages.push(tr)
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'assistant', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = []
        const toolCalls: OpenAIToolCall[] = []

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_use') {
            const tuBlock = block as AnthropicToolUseBlock
            toolCalls.push({
              id: tuBlock.id,
              type: 'function',
              function: {
                name: tuBlock.name,
                arguments: JSON.stringify(tuBlock.input)
              }
            })
          }
        }

        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('') : null
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls
        }
        messages.push(assistantMsg)
      }
    }
  }

  // Build OpenAI request body
  const openaiBody: Record<string, unknown> = {
    model: body.model,
    messages
  }

  // Convert tools
  const tools = body.tools as AnthropicTool[] | undefined
  if (tools && tools.length > 0) {
    openaiBody.tools = tools.map((t): OpenAITool => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    }))
  }

  // Convert tool_choice
  const toolChoice = body.tool_choice as AnthropicToolChoice | undefined
  if (toolChoice) {
    switch (toolChoice.type) {
      case 'auto':
        openaiBody.tool_choice = 'auto'
        break
      case 'any':
        openaiBody.tool_choice = 'required'
        break
      case 'none':
        openaiBody.tool_choice = 'none'
        break
      case 'tool':
        openaiBody.tool_choice = { type: 'function', function: { name: toolChoice.name } }
        break
    }
  }

  // Pass through simple parameters
  if (body.max_tokens !== undefined) openaiBody.max_tokens = body.max_tokens
  if (body.temperature !== undefined) openaiBody.temperature = body.temperature
  if (body.top_p !== undefined) openaiBody.top_p = body.top_p
  if (body.stop_sequences !== undefined) openaiBody.stop = body.stop_sequences

  return openaiBody
}

/**
 * Convert OpenAI Chat Completions response to Anthropic Messages format
 */
function convertFromOpenAI(openaiResponse: OpenAIResponse, model: string): Record<string, unknown> {
  const choice = openaiResponse.choices?.[0]
  const message = choice?.message
  const finishReason = choice?.finish_reason || null
  const usage = openaiResponse.usage

  const content: Record<string, unknown>[] = []

  // Add text content
  if (message?.content) {
    content.push({ type: 'text', text: message.content })
  }

  // Add tool use blocks
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      let input: unknown
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        input = {}
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input
      })
    }
  }

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinishReason(finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0
    }
  }
}

// -- Translator implementation --

export const openaiMessagesTranslator: MessagesTranslator = {
  name: 'openai-messages',

  async executeRequest(
    body: Record<string, unknown>,
    res: express.Response,
    requestId: string
  ): Promise<void> {
    const openaiBody = convertToOpenAI(body)
    openaiBody.stream = false

    logger.debug('OpenAI messages translator: executing non-streaming request', {
      requestId,
      model: body.model
    })

    const resolved = await tokenManager.getToken('openai')

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(openaiBody)
    })

    if (!upstream.ok) {
      const errorText = await upstream.text()
      logger.error('OpenAI messages translator: upstream error', {
        requestId,
        status: upstream.status,
        error: errorText
      })
      res.status(upstream.status).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: `OpenAI API error: ${upstream.status} ${errorText}`
        }
      })
      return
    }

    const openaiResponse = (await upstream.json()) as OpenAIResponse
    const anthropicResponse = convertFromOpenAI(openaiResponse, String(body.model))

    res.setHeader('Content-Type', 'application/json')
    res.json(anthropicResponse)
  },

  async executeStreamRequest(
    body: Record<string, unknown>,
    res: express.Response,
    requestId: string
  ): Promise<void> {
    const openaiBody = convertToOpenAI(body)
    openaiBody.stream = true

    logger.debug('OpenAI messages translator: executing streaming request', {
      requestId,
      model: body.model
    })

    const resolved = await tokenManager.getToken('openai')

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(openaiBody)
    })

    if (!upstream.ok) {
      const errorText = await upstream.text()
      logger.error('OpenAI messages translator: upstream streaming error', {
        requestId,
        status: upstream.status,
        error: errorText
      })
      res.status(upstream.status).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: `OpenAI API error: ${upstream.status} ${errorText}`
        }
      })
      return
    }

    setupSSEHeaders(res)

    const messageId = generateMessageId()
    const model = String(body.model)

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

    // Parse upstream SSE stream
    const reader = upstream.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let blockIndex = 0
    let currentBlockType: 'text' | 'tool_use' | null = null
    let finishReason: string | null = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const parts = buffer.split('\n')
        buffer = parts.pop() || ''

        for (const line of parts) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue

          let chunk: Record<string, unknown>
          try {
            chunk = JSON.parse(data)
          } catch {
            continue
          }

          const choices = chunk.choices as
            { delta: Record<string, unknown>; finish_reason: string | null }[] | undefined
          const delta = choices?.[0]?.delta
          const fr = choices?.[0]?.finish_reason

          if (delta?.content) {
            // Text content delta
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
                delta: { type: 'text_delta', text: delta.content }
              })}\n\n`
            )
          }

          if (delta?.tool_calls) {
            const toolCalls = delta.tool_calls as {
              id?: string
              index?: number
              function?: { name?: string; arguments?: string }
            }[]
            for (const tc of toolCalls) {
              if (tc.id) {
                // New tool call start
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
                res.write(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: tc.id,
                      name: tc.function?.name || ''
                    }
                  })}\n\n`
                )
              }
              if (tc.function?.arguments) {
                res.write(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                  })}\n\n`
                )
              }
            }
          }

          if (fr) finishReason = fr
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
      const stopReason = mapFinishReason(finishReason)
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 0 }
        })}\n\n`
      )
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      res.end()

      logger.debug('OpenAI messages translator: streaming completed', {
        requestId,
        finishReason
      })
    } catch (err: unknown) {
      const details = getErrorDetails(err)
      logger.error('OpenAI messages translator: streaming error', {
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

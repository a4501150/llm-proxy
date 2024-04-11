/**
 * OpenAI Translator - passthrough to OpenAI API (no format conversion)
 */

import { Readable } from 'stream'
import express from 'express'
import { Translator, TranslatorConfig } from './types'
import type { OpenAIChatRequest, OpenAIChatResponse } from '../types'
import { logger } from '../../logger'
import { tokenManager } from '../../shared/oauth/token-manager.js'
import { setupSSEHeaders } from '../../shared/sse-utils'
import { getErrorDetails } from '../../shared/errors'

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'

export const openaiTranslator: Translator = {
  name: 'openai',

  matchesModel(_model: string): boolean {
    // Passthrough — accepts any model name
    return true
  },

  async executeRequest(
    request: OpenAIChatRequest,
    _config: TranslatorConfig,
    requestId: string
  ): Promise<OpenAIChatResponse> {
    const resolved = await tokenManager.getToken('openai')

    logger.debug('OpenAI translator: executing non-streaming request', {
      requestId,
      model: request.model
    })

    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ...request, stream: false })
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error('OpenAI translator: upstream error', {
        requestId,
        status: response.status,
        error: errorText.slice(0, 1000)
      })
      const err = new Error(`OpenAI API error: ${response.status} ${errorText.slice(0, 500)}`)
      ;(err as unknown as Record<string, unknown>).status = response.status
      throw err
    }

    const data = (await response.json()) as OpenAIChatResponse

    logger.debug('OpenAI translator: request completed', {
      requestId,
      model: data.model,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens
    })

    return data
  },

  async executeStreamRequest(
    request: OpenAIChatRequest,
    _config: TranslatorConfig,
    res: express.Response,
    requestId: string
  ): Promise<void> {
    const resolved = await tokenManager.getToken('openai')

    logger.debug('OpenAI translator: executing streaming request', {
      requestId,
      model: request.model
    })

    const upstream = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ...request, stream: true })
    })

    if (!upstream.ok) {
      const errorText = await upstream.text()
      logger.error('OpenAI translator: upstream streaming error', {
        requestId,
        status: upstream.status,
        error: errorText.slice(0, 1000)
      })
      const err = new Error(`OpenAI API error: ${upstream.status} ${errorText.slice(0, 500)}`)
      ;(err as unknown as Record<string, unknown>).status = upstream.status
      throw err
    }

    if (!upstream.body) {
      throw new Error('OpenAI API returned no response body')
    }

    // Set up SSE headers and pipe the upstream SSE stream directly
    setupSSEHeaders(res)

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
      const details = getErrorDetails(err)
      logger.error('OpenAI translator: stream error', {
        requestId,
        error: details.message
      })
      if (!res.writableEnded) {
        res.end()
      }
    })

    nodeStream.pipe(res)

    res.on('close', () => {
      reader.cancel().catch(() => {})
      nodeStream.destroy()
    })

    // Wait for the stream to finish
    await new Promise<void>((resolve, reject) => {
      res.on('finish', () => {
        logger.debug('OpenAI translator: streaming completed', { requestId })
        resolve()
      })
      nodeStream.on('error', reject)
    })
  }
}

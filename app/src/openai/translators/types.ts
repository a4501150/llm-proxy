/**
 * Translator interface for OpenAI-compatible API
 * Translators convert between OpenAI format and native provider formats
 */

import express from 'express'
import type { OpenAIChatRequest, OpenAIChatResponse } from '../types'

/**
 * LLM provider types for routing
 */
export type LLMProvider = 'openai' | 'claude' | 'google' | 'vertex-ai'

export const VALID_PROVIDERS: LLMProvider[] = ['openai', 'claude', 'google', 'vertex-ai']

/**
 * Configuration for translator requests
 */
export interface TranslatorConfig {
  provider: LLMProvider
  vertexProject?: string
  vertexLocation?: string
}

/**
 * Translator interface - converts OpenAI format to/from native provider format
 */
export interface Translator {
  /**
   * Display name for logging
   */
  name: string

  /**
   * Check if this translator handles the given model
   */
  matchesModel(model: string): boolean

  /**
   * Execute a non-streaming request
   * @param request The OpenAI-format request
   * @param config Project/location configuration
   * @param requestId Unique request ID for logging
   * @returns OpenAI-format response
   */
  executeRequest(
    request: OpenAIChatRequest,
    config: TranslatorConfig,
    requestId: string
  ): Promise<OpenAIChatResponse>

  /**
   * Execute a streaming request
   * Writes OpenAI-format SSE chunks directly to response
   * @param request The OpenAI-format request
   * @param config Project/location configuration
   * @param res Express response object
   * @param requestId Unique request ID for logging
   */
  executeStreamRequest(
    request: OpenAIChatRequest,
    config: TranslatorConfig,
    res: express.Response,
    requestId: string
  ): Promise<void>
}

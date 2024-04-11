/**
 * Utility functions for OpenAI-compatible API
 */

import type { OpenAIFinishReason } from './types'

/**
 * Generate a unique completion ID in OpenAI format
 * Format: chatcmpl-{random}
 */
export function generateCompletionId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 11)}`
}

/**
 * Generate a unique tool call ID in OpenAI format
 * Format: call_{random}
 */
export function generateToolCallId(): string {
  return `call_${Math.random().toString(36).substring(2, 11)}${Math.random().toString(36).substring(2, 6)}`
}

/**
 * Generate a unique request ID for logging
 */
export function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}

/**
 * Get current Unix timestamp in seconds
 */
export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Map Claude stop_reason to OpenAI finish_reason
 */
export function mapClaudeFinishReason(stopReason: string | null | undefined): OpenAIFinishReason {
  if (!stopReason) return null

  switch (stopReason) {
    case 'end_turn':
      return 'stop'
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    default:
      return 'stop'
  }
}

/**
 * Map Gemini finishReason to OpenAI finish_reason
 */
export function mapGeminiFinishReason(finishReason: string | null | undefined): OpenAIFinishReason {
  if (!finishReason) return null

  switch (finishReason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
      return 'content_filter'
    case 'RECITATION':
      return 'content_filter'
    case 'TOOL_CALLS':
      // Gemini uses different field name
      return 'tool_calls'
    default:
      return 'stop'
  }
}

/**
 * Get client IP from request
 */
export function getClientIP(req: {
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
}): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim()
  }
  return req.socket?.remoteAddress || 'unknown'
}

/**
 * Map HTTP status code to OpenAI error type
 */
export function mapStatusToErrorType(
  status: number
): 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'server_error' {
  if (status === 401 || status === 403) {
    return 'authentication_error'
  }
  if (status === 429) {
    return 'rate_limit_error'
  }
  if (status >= 400 && status < 500) {
    return 'invalid_request_error'
  }
  return 'server_error'
}

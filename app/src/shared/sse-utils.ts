/**
 * SSE (Server-Sent Events) utilities for streaming responses
 * Shared between Claude and Gemini providers
 */

import type { Response } from 'express'

/**
 * Configure response headers for SSE streaming
 * Sets all required headers and optimizations for real-time streaming
 */
export function setupSSEHeaders(res: Response): void {
  // Standard SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')

  // Disable buffering in nginx/reverse proxies
  res.setHeader('X-Accel-Buffering', 'no')

  // Flush headers immediately to establish connection
  res.flushHeaders()

  // Disable Nagle algorithm for real-time streaming
  if (res.socket) {
    res.socket.setNoDelay(true)
  }
}

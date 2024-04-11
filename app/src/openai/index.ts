/**
 * OpenAI-compatible API routes
 */

import type { Application } from '../declarations'
import { chatCompletionsHandler } from './chat-completions'

/**
 * Set up OpenAI-compatible API routes
 */
export const setupOpenAIProxy = (app: Application): void => {
  // POST /v1/chat/completions - Chat completions endpoint
  app.post('/v1/chat/completions', chatCompletionsHandler)
}

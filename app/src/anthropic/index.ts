import type { Application } from '../declarations'
import { anthropicMessagesHandler } from './messages'

export const setupAnthropicMessages = (app: Application): void => {
  app.post('/v1/messages', anthropicMessagesHandler)
}

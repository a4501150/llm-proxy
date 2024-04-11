import type { Application } from '../declarations'
import { claudeProxyHandler } from './proxy'

export const setupClaudeProxy = (app: Application): void => {
  app.use('/claude', claudeProxyHandler)
}

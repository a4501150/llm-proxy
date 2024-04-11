// For more information about this file see https://dove.feathersjs.com/guides/cli/application.html
import compression from 'compression'
import configuration from '@feathersjs/configuration'
import express, { cors, errorHandler, json, notFound, rest, urlencoded } from '@feathersjs/express'
import { feathers } from '@feathersjs/feathers'

import type { Application } from './declarations'

import { logError } from './hooks/log-error'
import { logger } from './logger'
import { initializeConnectionPool } from './shared/connection-pool'
import { setupOpenAIProxy } from './openai'
import { setupClaudeProxy } from './claude-proxy'
import { setupOpenAIDirectProxy } from './openai-proxy'
import { setupGoogleDirectProxy } from './google-proxy'
import { setupVertexAIDirectProxy } from './vertexai-proxy'
import { setupAnthropicMessages } from './anthropic'
import { setupChatGPTProxy } from './chatgpt-proxy'
import { setupOAuthRoutes } from './oauth'

const app: Application = express(feathers())

export async function createApp() {
  // Initialize connection pooling for HTTP keep-alive and connection reuse
  initializeConnectionPool()

  app.configure(configuration())
  app.use(cors())
  app.use(json({ limit: '1024mb' }))
  app.use(urlencoded({ extended: true, limit: '1024mb' }))
  app.use(
    compression({
      filter: (req, res) => {
        // Skip compression for SSE streaming responses
        // Use startsWith to handle charset suffixes like "text/event-stream; charset=utf-8"
        const contentType = res.getHeader('Content-Type')
        if (typeof contentType === 'string' && contentType.startsWith('text/event-stream')) {
          return false
        }
        return compression.filter(req, res)
      }
    })
  )

  app.configure(rest())

  app.configure(setupOpenAIProxy)
  app.configure(setupAnthropicMessages)
  app.configure(setupClaudeProxy)
  app.configure(setupOAuthRoutes)
  app.configure(setupOpenAIDirectProxy)
  app.configure(setupGoogleDirectProxy)
  app.configure(setupVertexAIDirectProxy)
  app.configure(setupChatGPTProxy)

  // Suppress favicon.ico requests to avoid noisy 404 logs
  app.use('/favicon.ico', ((_req: any, res: any) => {
    res.status(204).end()
  }) as any)

  app.use(notFound())
  app.use(errorHandler({ logger }))

  app.hooks({
    around: {
      all: [logError]
    },
    before: {},
    after: {},
    error: {}
  })
  app.hooks({
    setup: [],
    teardown: []
  })
  return app
}

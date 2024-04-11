// For more information about this file see https://dove.feathersjs.com/guides/cli/application.html
import { createApp } from './app'
import { logger } from './logger'
import { sharedAgent } from './shared/connection-pool'
import { tokenManager } from './shared/oauth/token-manager.js'

function row(content: string): string {
  // Box inner width = 62 chars (between the two ║ chars)
  return `║  ${content.padEnd(59)}║`
}

async function printStartupBanner(host: string, port: number): Promise<void> {
  const baseUrl = `http://${host}:${port}`

  const statuses = tokenManager.getAllStatuses(baseUrl)

  const border = '═'.repeat(61)
  const lines = [
    '',
    `╔${border}╗`,
    row('Vertex AI Proxy'),
    row(`Listening on ${baseUrl}`),
    `╠${border}╣`,
    row('Endpoints:'),
    row(`  Vertex:   POST /v1/projects/.../models/{model}`),
    row(`  Compat:   POST /v1/chat/completions`),
    row(`  Messages: POST /v1/messages  -> Vertex AI`),
    row(`  Claude:   /claude/*  -> api.anthropic.com`),
    row(`  OpenAI:   /openai/*  -> api.openai.com`),
    row(`  Google:   /google/*  -> generativelanguage..`),
    row(`  Dashboard: GET /oauth`),
    `╠${border}╣`,
    row('OAuth Providers:')
  ]

  const unauthUrls: string[] = []

  for (const status of statuses) {
    let detail: string
    if (status.method === 'env') {
      detail = `${status.name}: Using ${status.id.toUpperCase()}_API_KEY env var`
    } else if (status.authenticated) {
      const expires = status.expiresAt ? ` (expires ${status.expiresAt})` : ''
      detail = `${status.name}: Authenticated${expires}`
      if (status.displayInfo) {
        for (const [key, value] of Object.entries(status.displayInfo)) {
          lines.push(row(`    ${key}: ${value}`))
        }
      }
    } else {
      detail = `${status.name}: Not authenticated`
      if (status.authorizeUrl) {
        unauthUrls.push(`  ${status.name}: ${status.authorizeUrl}`)
      }
    }
    lines.push(row(`  ${detail}`))
  }

  if (unauthUrls.length > 0) {
    lines.push(`╠${border}╣`)
    lines.push(row('Authenticate at:'))
    lines.push(row(`  ${baseUrl}/oauth`))
  }

  lines.push(`╚${border}╝`)

  if (unauthUrls.length > 0) {
    lines.push('')
    lines.push('Provider auth URLs:')
    for (const url of unauthUrls) {
      lines.push(url)
    }
    lines.push('')
  }

  // Use console.log for the banner so it's always visible regardless of log level
  console.log(lines.join('\n'))
}

createApp().then((app) => {
  const port = app.get('port')
  const host = app.get('host')

  process.on('unhandledRejection', (reason) => logger.error('Unhandled Rejection %O', reason))

  app.listen(port).then(async (server) => {
    logger.info(`Feathers app listening on http://${host}:${port}`)

    await printStartupBanner(host, port)

    const shutdown = () => {
      logger.info('Shutting down gracefully...')
      server.close(() => {
        logger.info('HTTP server closed')
        sharedAgent
          .close()
          .then(() => {
            logger.info('Connection pool closed')
            process.exit(0)
          })
          .catch(() => {
            process.exit(1)
          })
      })
    }

    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  })
})

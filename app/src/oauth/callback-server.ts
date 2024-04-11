import http from 'http'
import { logger } from '../logger.js'
import { tokenManager } from '../shared/oauth/token-manager.js'
import type { OAuthProviderId } from '../shared/oauth/types.js'

const TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const SUCCESS_HTML = (providerName: string) => `<!DOCTYPE html>
<html>
<head><title>OAuth Success</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
  <div style="text-align: center; padding: 2rem; background: #16213e; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">
    <h1 style="color: #4ecca3;">Authentication Successful</h1>
    <p>${providerName} is now connected. You can close this tab.</p>
  </div>
</body>
</html>`

const ERROR_HTML = (message: string) => `<!DOCTYPE html>
<html>
<head><title>OAuth Error</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
  <div style="text-align: center; padding: 2rem; background: #16213e; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">
    <h1 style="color: #e74c3c;">Authentication Failed</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`

// Track active callback servers so we don't start duplicates
const activeServers = new Map<OAuthProviderId, http.Server>()

/**
 * Start a temporary HTTP server on the required port to catch an OAuth callback
 * for providers with fixed registered redirect URIs.
 *
 * The server auto-closes after handling the callback or after a 5-minute timeout.
 */
export function startCallbackServer(providerId: OAuthProviderId, port: number, callbackPath: string): void {
  // Close any existing server for this provider
  const existing = activeServers.get(providerId)
  if (existing) {
    existing.close()
    activeServers.delete(providerId)
  }

  const provider = tokenManager.getProvider(providerId)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '', `http://localhost:${port}`)

    if (url.pathname !== callbackPath) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(ERROR_HTML('Callback route not found.'))
      return
    }

    const error = url.searchParams.get('error')
    if (error) {
      const errorDesc = url.searchParams.get('error_description') || error
      logger.error('OAuth callback received error', { provider: providerId, error, errorDesc })
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(ERROR_HTML(errorDesc))
      cleanup()
      return
    }

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')

    if (!code || !state) {
      logger.error('OAuth callback missing code or state', { provider: providerId })
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(ERROR_HTML('Missing authorization code or state parameter.'))
      cleanup()
      return
    }

    try {
      await tokenManager.handleCallback(providerId, code, state)
      logger.info('OAuth authentication completed via callback server', { provider: providerId, port })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(SUCCESS_HTML(provider.name))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('OAuth callback error', { provider: providerId, error: message })
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(ERROR_HTML(`Token exchange failed: ${message}`))
    }

    cleanup()
  })

  const timeout = setTimeout(() => {
    logger.info('OAuth callback server timed out', { provider: providerId, port })
    cleanup()
  }, TIMEOUT_MS)

  function cleanup() {
    clearTimeout(timeout)
    server.close()
    activeServers.delete(providerId)
    logger.debug('OAuth callback server closed', { provider: providerId, port })
  }

  server.listen(port, '0.0.0.0', () => {
    activeServers.set(providerId, server)
    logger.info('OAuth callback server started', { provider: providerId, port, callbackPath })
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.error('OAuth callback server failed to start', {
      provider: providerId,
      port,
      error: err.message,
      code: err.code
    })
    clearTimeout(timeout)
    activeServers.delete(providerId)
  })
}

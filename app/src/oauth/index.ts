import type { Application } from '../declarations.js'
import type express from 'express'
import { oauthCallbackHandler } from './callback.js'
import { startCallbackServer } from './callback-server.js'
import { dashboardHandler } from './dashboard.js'
import { validateAuthentication } from '../shared/auth.js'
import { tokenManager } from '../shared/oauth/token-manager.js'
import type { OAuthProviderId } from '../shared/oauth/types.js'
import { logger } from '../logger.js'

/**
 * Pull the most useful message out of nested upstream errors.
 * e.g. `Token exchange failed for anthropic: 400 {"error":{"message":"Invalid request format"},...}`
 *      -> `Anthropic: Invalid request format (400)`
 */
function humanizeUpstreamError(raw: string): string {
  const match = raw.match(/^Token (?:exchange|refresh) failed for (\w+): (\d+) (.+)$/s)
  if (!match) return raw
  const [, providerId, status, body] = match
  const provider = providerId.charAt(0).toUpperCase() + providerId.slice(1)
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const inner = parsed.error as Record<string, unknown> | string | undefined
    let msg: string | undefined
    if (typeof inner === 'string') {
      msg = inner
    } else if (inner && typeof inner === 'object') {
      msg = (inner.message as string) || (inner.error_description as string) || (inner.type as string)
    }
    msg = msg || (parsed.error_description as string) || (parsed.message as string)
    if (msg) return `${provider}: ${msg} (${status})`
  } catch {
    // fall through
  }
  return `${provider}: ${body.slice(0, 200)} (${status})`
}

export const setupOAuthRoutes = (app: Application): void => {
  const expressApp = app as unknown as express.Application

  // Dashboard - read-only status page
  expressApp.get('/oauth', dashboardHandler)

  // OAuth callback - handles redirects from all providers
  expressApp.get('/oauth/callback/:provider', oauthCallbackHandler)

  // Legacy callback path for Anthropic (backward compat)
  expressApp.get('/callback', (req: express.Request, res: express.Response) => {
    const query = new URLSearchParams(req.query as Record<string, string>).toString()
    res.redirect(`/oauth/callback/anthropic${query ? '?' + query : ''}`)
  })

  // Login redirect - redirects to provider's authorize URL
  expressApp.get('/oauth/login/:provider', (req: express.Request, res: express.Response) => {
    const providerId = req.params.provider as OAuthProviderId

    let provider
    try {
      provider = tokenManager.getProvider(providerId)
    } catch {
      res.status(404).json({ error: `Unknown provider: ${providerId}` })
      return
    }

    const port = app.get('port')
    const host = app.get('host')
    const publicUrl =
      (app as any).get('publicUrl') || `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`
    const flowState = tokenManager.startOAuthFlow(providerId, publicUrl)

    // For providers with fixed redirect URIs pointing at localhost, start a temporary callback server
    if (provider.fixedRedirectUri) {
      const url = new URL(provider.fixedRedirectUri)
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        const callbackPort = parseInt(url.port, 10)
        startCallbackServer(providerId, callbackPort, url.pathname)
      }
    }

    res.redirect(flowState.authorizeUrl)
  })

  // Manual code completion - for when the callback server isn't reachable (remote deployments)
  expressApp.post('/oauth/complete/:provider', async (req: express.Request, res: express.Response) => {
    const providerId = req.params.provider as OAuthProviderId

    try {
      tokenManager.getProvider(providerId)
    } catch {
      res.status(404).json({ error: `Unknown provider: ${providerId}` })
      return
    }

    const input = (req.body.redirect_url || '') as string
    if (!input) {
      res.status(400).json({ error: 'redirect_url is required' })
      return
    }

    try {
      const url = new URL(input)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (!code || !state) {
        res.status(400).json({ error: 'URL must contain code and state parameters' })
        return
      }

      await tokenManager.handleCallback(providerId, code, state)
      logger.info('OAuth completed via manual paste', { provider: providerId })
      res.json({ provider: providerId, status: 'ok' })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const message = humanizeUpstreamError(raw)
      logger.error('OAuth manual completion failed', { provider: providerId, error: raw })
      res.status(400).json({ error: message, raw })
    }
  })

  // Token endpoint - expose token (requires Bearer auth)
  expressApp.get('/oauth/token/:provider', async (req: express.Request, res: express.Response) => {
    const providerId = req.params.provider as OAuthProviderId
    const requestId = `oauth-token-${Date.now()}`
    const clientIP = req.socket.remoteAddress || 'unknown'

    const authResult = validateAuthentication(req, requestId, clientIP)
    if (!authResult.success) {
      res.status(authResult.statusCode).json({ error: authResult.error })
      return
    }

    try {
      const resolved = await tokenManager.getToken(providerId)
      res.json({
        provider: providerId,
        type: resolved.type,
        token: resolved.token,
        ...(resolved.extra ? { extra: resolved.extra } : {})
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(404).json({ error: message })
    }
  })

  // Logout endpoint - delete provider credentials (requires Bearer auth)
  expressApp.post('/oauth/logout/:provider', (req: express.Request, res: express.Response) => {
    const providerId = req.params.provider as OAuthProviderId
    const requestId = `oauth-logout-${Date.now()}`
    const clientIP = req.socket.remoteAddress || 'unknown'

    const authResult = validateAuthentication(req, requestId, clientIP)
    if (!authResult.success) {
      res.status(authResult.statusCode).json({ error: authResult.error })
      return
    }

    try {
      tokenManager.getProvider(providerId)
    } catch {
      res.status(404).json({ error: `Unknown provider: ${providerId}` })
      return
    }

    tokenManager.deleteCredentials(providerId)
    logger.info('OAuth credentials deleted', { provider: providerId })
    res.json({ provider: providerId, status: 'logged_out' })
  })
}

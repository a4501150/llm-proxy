import express from 'express'
import { logger } from '../logger.js'
import { tokenManager } from '../shared/oauth/token-manager.js'
import type { OAuthProviderId } from '../shared/oauth/types.js'

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function oauthCallbackHandler(req: express.Request, res: express.Response): Promise<void> {
  const providerId = req.params.provider as OAuthProviderId

  // Validate provider
  let provider
  try {
    provider = tokenManager.getProvider(providerId)
  } catch {
    res.status(404).send(ERROR_HTML(`Unknown provider: ${providerId}`))
    return
  }

  const error = req.query.error as string | undefined
  if (error) {
    const errorDesc = (req.query.error_description as string) || error
    logger.error('OAuth callback received error', { provider: providerId, error, errorDesc })
    res.status(400).send(ERROR_HTML(errorDesc))
    return
  }

  const code = req.query.code as string | undefined
  const state = req.query.state as string | undefined

  if (!code || !state) {
    logger.error('OAuth callback missing code or state', { provider: providerId })
    res.status(400).send(ERROR_HTML('Missing authorization code or state parameter.'))
    return
  }

  try {
    await tokenManager.handleCallback(providerId, code, state)
    logger.info('OAuth authentication completed', { provider: providerId })
    res.status(200).send(SUCCESS_HTML(provider.name))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('OAuth callback error', { provider: providerId, error: message })
    res.status(500).send(ERROR_HTML(`Token exchange failed: ${message}`))
  }
}

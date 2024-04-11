import { logger } from '../../logger.js'
import { CredentialStore } from './credential-store.js'
import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce.js'
import { anthropicProvider } from './providers/anthropic.js'
import { googleProvider } from './providers/google.js'
import { openaiProvider } from './providers/openai.js'
import type {
  OAuthProviderConfig,
  OAuthProviderId,
  OAuthFlowState,
  ProviderCredentials,
  ProviderStatus,
  ResolvedToken
} from './types.js'

const REFRESH_BUFFER_MS = 5 * 60 * 1000

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
}

function buildTokenRequestInit(
  provider: OAuthProviderConfig,
  params: Record<string, string>
): { headers: Record<string, string>; body: string } {
  if (provider.tokenRequestFormat === 'json') {
    return {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(params)
    }
  }
  return {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  }
}

export class TokenManager {
  private providers = new Map<OAuthProviderId, OAuthProviderConfig>()
  private credentialStore = new CredentialStore()
  private flowStates = new Map<OAuthProviderId, OAuthFlowState>()
  private refreshPromises = new Map<OAuthProviderId, Promise<void>>()

  registerProvider(config: OAuthProviderConfig): void {
    this.providers.set(config.id, config)
    logger.debug(`OAuth provider registered: ${config.id}`)
  }

  getProvider(id: OAuthProviderId): OAuthProviderConfig {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error(`OAuth provider not registered: ${id}`)
    }
    return provider
  }

  getProviders(): OAuthProviderConfig[] {
    return Array.from(this.providers.values())
  }

  startOAuthFlow(providerId: OAuthProviderId, baseUrl: string): OAuthFlowState {
    const provider = this.getProvider(providerId)

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()
    const redirectUri = provider.fixedRedirectUri ?? baseUrl + provider.callbackPath

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      scope: provider.scopes
    })

    if (provider.extraAuthorizeParams) {
      for (const [key, value] of Object.entries(provider.extraAuthorizeParams)) {
        params.set(key, value)
      }
    }

    const authorizeUrl = `${provider.authorizeUrl}?${params.toString()}`

    const flowState: OAuthFlowState = {
      authorizeUrl,
      codeVerifier,
      state,
      redirectUri
    }

    this.flowStates.set(providerId, flowState)
    logger.info(`OAuth flow started for ${providerId}`, { authorizeUrl })

    return flowState
  }

  async handleCallback(providerId: OAuthProviderId, code: string, state: string): Promise<void> {
    const provider = this.getProvider(providerId)
    const flowState = this.flowStates.get(providerId)

    if (!flowState) {
      throw new Error(`No OAuth flow in progress for ${providerId}`)
    }

    if (flowState.state !== state) {
      throw new Error(`OAuth state mismatch for ${providerId}`)
    }

    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: provider.clientId,
      code,
      redirect_uri: flowState.redirectUri,
      code_verifier: flowState.codeVerifier
    }

    if (provider.includeStateInTokenExchange) {
      params.state = state
    }

    if (provider.clientSecret) {
      params.client_secret = provider.clientSecret
    }

    const response = await fetch(provider.tokenUrl, {
      method: 'POST',
      ...buildTokenRequestInit(provider, params)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Token exchange failed for ${providerId}: ${response.status} ${errorText}`)
    }

    const data = (await response.json()) as TokenResponse

    if (!data.access_token) {
      throw new Error(`Token exchange response missing access_token for ${providerId}`)
    }

    const credentials: ProviderCredentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? '',
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 3600 * 1000
    }

    if (provider.onLoginComplete) {
      await provider.onLoginComplete(credentials)
    }

    this.credentialStore.set(providerId, credentials)
    this.flowStates.delete(providerId)

    logger.info(`OAuth callback completed for ${providerId}`)
  }

  async getToken(providerId: OAuthProviderId): Promise<ResolvedToken> {
    const provider = this.getProvider(providerId)

    // Check environment variable first
    const envToken = process.env[provider.envKeyName]
    if (envToken) {
      return { type: 'api_key', token: envToken }
    }

    // Check credential store
    const credentials = this.credentialStore.get(providerId)
    if (!credentials) {
      throw new Error(`No credentials available for ${providerId}`)
    }

    // Auto-refresh if expired or about to expire
    if (Date.now() >= credentials.expiresAt - REFRESH_BUFFER_MS) {
      logger.info(`Token expired or expiring soon for ${providerId}, refreshing`)
      await this.refreshToken(providerId)
      const refreshed = this.credentialStore.get(providerId)
      if (!refreshed) {
        throw new Error(`Credentials lost after refresh for ${providerId}`)
      }
      return {
        type: 'oauth',
        token: refreshed.accessToken,
        extra: refreshed.extra
      }
    }

    return {
      type: 'oauth',
      token: credentials.accessToken,
      extra: credentials.extra
    }
  }

  async refreshToken(providerId: OAuthProviderId, staleToken?: string): Promise<void> {
    const credentials = this.credentialStore.get(providerId)
    if (!credentials) {
      throw new Error(`No credentials to refresh for ${providerId}`)
    }

    // If staleToken provided and current token differs, another refresh already happened
    if (staleToken && credentials.accessToken !== staleToken) {
      logger.debug(`Token already refreshed for ${providerId}, skipping`)
      return
    }

    // Deduplicate concurrent refreshes
    const existing = this.refreshPromises.get(providerId)
    if (existing) {
      return existing
    }

    const refreshPromise = this.doRefresh(providerId, credentials)
    this.refreshPromises.set(providerId, refreshPromise)

    try {
      await refreshPromise
    } finally {
      this.refreshPromises.delete(providerId)
    }
  }

  private async doRefresh(providerId: OAuthProviderId, credentials: ProviderCredentials): Promise<void> {
    const provider = this.getProvider(providerId)

    if (!credentials.refreshToken) {
      throw new Error(`No refresh token available for ${providerId}`)
    }

    const params: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: provider.clientId,
      refresh_token: credentials.refreshToken
    }

    if (provider.clientSecret) {
      params.client_secret = provider.clientSecret
    }

    logger.info(`Refreshing OAuth token for ${providerId}`)

    const response = await fetch(provider.tokenUrl, {
      method: 'POST',
      ...buildTokenRequestInit(provider, params)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Token refresh failed for ${providerId}: ${response.status} ${errorText}`)
    }

    const data = (await response.json()) as TokenResponse

    if (!data.access_token) {
      throw new Error(`Token refresh response missing access_token for ${providerId}`)
    }

    const updated: ProviderCredentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? credentials.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 3600 * 1000,
      scopes: credentials.scopes,
      extra: credentials.extra
    }

    this.credentialStore.set(providerId, updated)
    logger.info(`OAuth token refreshed for ${providerId}`)
  }

  hasCredentials(providerId: OAuthProviderId): boolean {
    const provider = this.providers.get(providerId)
    if (!provider) return false

    if (process.env[provider.envKeyName]) return true

    return this.credentialStore.has(providerId)
  }

  getAllStatuses(baseUrl: string): ProviderStatus[] {
    return this.getProviders().map((provider) => {
      const envToken = process.env[provider.envKeyName]
      if (envToken) {
        return {
          id: provider.id,
          name: provider.name,
          authenticated: true,
          method: 'env' as const
        }
      }

      const credentials = this.credentialStore.get(provider.id)
      if (credentials) {
        const status: ProviderStatus = {
          id: provider.id,
          name: provider.name,
          authenticated: true,
          method: 'oauth' as const,
          expiresAt: new Date(credentials.expiresAt).toISOString()
        }
        if (provider.getDisplayInfo) {
          status.displayInfo = provider.getDisplayInfo(credentials)
        }
        return status
      }

      // Not authenticated - reuse any in-progress flow so we don't clobber
      // the state value the user is about to paste back. Only start a fresh
      // flow if none exists yet.
      const flowState = this.flowStates.get(provider.id) ?? this.startOAuthFlow(provider.id, baseUrl)
      return {
        id: provider.id,
        name: provider.name,
        authenticated: false,
        method: 'none' as const,
        authorizeUrl: flowState.authorizeUrl
      }
    })
  }

  deleteCredentials(providerId: OAuthProviderId): void {
    this.credentialStore.delete(providerId)
    this.refreshPromises.delete(providerId)
    this.flowStates.delete(providerId)
    logger.info(`OAuth credentials deleted for ${providerId}`)
  }

  getCredentials(providerId: OAuthProviderId): ProviderCredentials | null {
    return this.credentialStore.get(providerId)
  }

  getFlowState(providerId: OAuthProviderId): OAuthFlowState | null {
    return this.flowStates.get(providerId) ?? null
  }
}

export const tokenManager = new TokenManager()
tokenManager.registerProvider(anthropicProvider)
tokenManager.registerProvider(openaiProvider)
tokenManager.registerProvider(googleProvider)

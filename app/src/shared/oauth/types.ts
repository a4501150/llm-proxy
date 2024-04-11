// Types for multi-provider OAuth system

export type OAuthProviderId = 'anthropic' | 'openai' | 'google'

export interface ProviderCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix timestamp in ms
  scopes?: string[]
  extra?: Record<string, unknown>
}

export interface AllCredentials {
  [providerId: string]: ProviderCredentials
}

export interface OAuthFlowState {
  authorizeUrl: string
  codeVerifier: string
  state: string
  redirectUri: string
}

export interface ResolvedToken {
  type: 'api_key' | 'oauth'
  token: string
  extra?: Record<string, unknown>
}

export interface ProviderStatus {
  id: OAuthProviderId
  name: string
  authenticated: boolean
  method: 'env' | 'oauth' | 'none'
  expiresAt?: string // ISO string
  displayInfo?: Record<string, string>
  authorizeUrl?: string
}

/**
 * Configuration for an OAuth provider.
 * Each provider implements this interface to define its OAuth flow parameters.
 */
export interface OAuthProviderConfig {
  readonly id: OAuthProviderId
  readonly name: string
  readonly envKeyName: string // e.g., 'ANTHROPIC_API_KEY'
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly clientId: string
  readonly clientSecret?: string // Google requires this
  readonly scopes: string
  readonly callbackPath: string // e.g., '/oauth/callback/anthropic'
  /** If set, use this exact redirect_uri instead of baseUrl + callbackPath (for providers with fixed registered URIs) */
  readonly fixedRedirectUri?: string

  /** Token endpoint body format. Defaults to 'form' (application/x-www-form-urlencoded). Anthropic uses 'json'. */
  readonly tokenRequestFormat?: 'form' | 'json'

  /** Include `state` in the token-exchange body. Anthropic expects it; OpenAI rejects it as unknown_parameter. */
  readonly includeStateInTokenExchange?: boolean

  /** Extra query params for the authorize URL */
  extraAuthorizeParams?: Record<string, string>

  /** Build auth headers for proxying requests with this provider's token */
  buildAuthHeaders(token: string, credentials: ProviderCredentials): Record<string, string>

  /** Post-login hook (e.g., fetch profile, extract accountId from JWT) */
  onLoginComplete?(credentials: ProviderCredentials): Promise<void>

  /** Get display info for dashboard/banner */
  getDisplayInfo?(credentials: ProviderCredentials): Record<string, string>
}

import type { OAuthProviderConfig } from '../types'

/**
 * Spotify Taskforce virtual-key auth for the Hendrix GenAI gateway.
 *
 * Not an OAuth flow: a static API key from https://taskforce.spotify.net/api-keys,
 * sent as the `apikey` header (the convention Snipe uses). The OAuth-shaped
 * fields below are inert placeholders so the provider fits the token-manager
 * registry; env-key resolution (HENDRIX_API_KEY) is the only path.
 *
 * The gateway 400s on /v1/messages without `anthropic-version`, so it is
 * injected here rather than left to clients.
 */
export const taskforceProvider: OAuthProviderConfig = {
  id: 'taskforce',
  name: 'Taskforce (Hendrix GenAI)',
  envKeyName: 'HENDRIX_API_KEY',
  authorizeUrl: 'https://taskforce.spotify.net/api-keys',
  tokenUrl: 'https://taskforce.spotify.net/api-keys',
  clientId: 'taskforce',
  scopes: '',
  callbackPath: '/oauth/callback/taskforce',

  buildAuthHeaders(token: string): Record<string, string> {
    return {
      apikey: token,
      'anthropic-version': '2023-06-01'
    }
  }
}

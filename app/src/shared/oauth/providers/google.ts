import { logger } from '../../../logger.js'
import type { OAuthProviderConfig, ProviderCredentials } from '../types.js'

const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'

export const googleProvider: OAuthProviderConfig = {
  id: 'google',
  name: 'Google (Gemini CLI)',
  envKeyName: 'GOOGLE_API_KEY',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: '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',
  scopes:
    'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
  callbackPath: '/oauth2callback',
  fixedRedirectUri: 'http://localhost:8085/oauth2callback',

  extraAuthorizeParams: {
    access_type: 'offline',
    prompt: 'consent'
  },

  buildAuthHeaders(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`
    }
  },

  async onLoginComplete(credentials: ProviderCredentials): Promise<void> {
    try {
      const response = await fetch(USERINFO_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`
        }
      })

      if (!response.ok) {
        logger.warn('Failed to fetch Google user info', { status: response.status })
        return
      }

      const data = (await response.json()) as { email?: string; name?: string }

      if (!credentials.extra) credentials.extra = {}
      if (data.email) {
        credentials.extra.email = data.email
      }

      logger.info('Google user info fetched', {
        email: data.email
      })
    } catch (err) {
      logger.warn('Error fetching Google user info', { error: (err as Error).message })
    }
  },

  getDisplayInfo(credentials: ProviderCredentials): Record<string, string> {
    const email = credentials.extra?.email as string | undefined
    if (!email) return {}
    return { email }
  }
}

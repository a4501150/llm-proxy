import { logger } from '../../../logger.js'
import type { OAuthProviderConfig, ProviderCredentials } from '../types.js'

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

type JwtPayload = {
  [JWT_CLAIM_PATH]?: {
    chatgpt_account_id?: string
  }
  [key: string]: unknown
}

function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1] ?? ''
    const decoded = Buffer.from(payload, 'base64').toString('utf-8')
    return JSON.parse(decoded) as JwtPayload
  } catch {
    return null
  }
}

export const openaiProvider: OAuthProviderConfig = {
  id: 'openai',
  name: 'OpenAI (ChatGPT Plus/Pro)',
  envKeyName: 'OPENAI_API_KEY',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  scopes: 'openid profile email offline_access',
  callbackPath: '/auth/callback',
  fixedRedirectUri: 'http://localhost:1455/auth/callback',
  extraAuthorizeParams: {
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'pi'
  },

  buildAuthHeaders(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`
    }
  },

  async onLoginComplete(credentials: ProviderCredentials): Promise<void> {
    try {
      const payload = decodeJwt(credentials.accessToken)
      const auth = payload?.[JWT_CLAIM_PATH]
      const accountId = auth?.chatgpt_account_id

      if (typeof accountId === 'string' && accountId.length > 0) {
        if (!credentials.extra) credentials.extra = {}
        credentials.extra.accountId = accountId
        logger.info('OpenAI OAuth accountId extracted', { accountId })
      } else {
        logger.warn('OpenAI OAuth: could not extract accountId from access token')
      }
    } catch (err) {
      logger.warn('OpenAI OAuth: error decoding access token JWT', {
        error: (err as Error).message
      })
    }
  },

  getDisplayInfo(credentials: ProviderCredentials): Record<string, string> {
    const accountId = credentials.extra?.accountId
    if (typeof accountId === 'string') {
      return { accountId }
    }
    return {}
  }
}

import { logger } from '../../../logger'
import type { OAuthProviderConfig, ProviderCredentials } from '../types'

const PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile'

export interface AnthropicProfile {
  accountUuid: string
  email: string
  displayName?: string
  organizationUuid: string
  organizationType?: string
  billingType?: string
}

export const anthropicProvider: OAuthProviderConfig = {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  envKeyName: 'ANTHROPIC_API_KEY',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scopes:
    'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  callbackPath: '/oauth/callback/anthropic',
  fixedRedirectUri: 'https://platform.claude.com/oauth/code/callback',
  tokenRequestFormat: 'json',
  includeStateInTokenExchange: true,

  buildAuthHeaders(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20'
    }
  },

  async onLoginComplete(credentials: ProviderCredentials): Promise<void> {
    try {
      const response = await fetch(PROFILE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        logger.warn('Failed to fetch Anthropic OAuth profile', { status: response.status })
        return
      }

      const data = (await response.json()) as {
        account?: { uuid?: string; email?: string; display_name?: string }
        organization?: { uuid?: string; organization_type?: string; billing_type?: string }
      }

      if (!data.account?.uuid || !data.organization?.uuid) {
        logger.warn('Anthropic OAuth profile response missing required fields')
        return
      }

      const profile: AnthropicProfile = {
        accountUuid: data.account.uuid,
        email: data.account.email ?? '',
        displayName: data.account.display_name,
        organizationUuid: data.organization.uuid,
        organizationType: data.organization.organization_type,
        billingType: data.organization.billing_type
      }

      if (!credentials.extra) credentials.extra = {}
      credentials.extra.profile = profile

      logger.info('Anthropic OAuth profile fetched', {
        accountUuid: profile.accountUuid,
        email: profile.email,
        organizationUuid: profile.organizationUuid
      })
    } catch (err) {
      logger.warn('Error fetching Anthropic OAuth profile', { error: (err as Error).message })
    }
  },

  getDisplayInfo(credentials: ProviderCredentials): Record<string, string> {
    const profile = credentials.extra?.profile as AnthropicProfile | undefined
    if (!profile) return {}
    return {
      email: profile.email,
      account: profile.accountUuid,
      org: profile.organizationUuid,
      ...(profile.billingType ? { billing: profile.billingType } : {})
    }
  }
}

/**
 * Get the Anthropic profile from credentials.
 */
export function getAnthropicProfile(credentials: ProviderCredentials): AnthropicProfile | null {
  return (credentials.extra?.profile as AnthropicProfile) ?? null
}

/**
 * Build metadata.user_id matching Claude Code's format.
 */
export function buildMetadataUserId(
  credentials: ProviderCredentials,
  deviceId: string,
  sessionId: string
): string | null {
  const profile = getAnthropicProfile(credentials)
  if (!profile) return null
  return `user_${deviceId}_account_${profile.accountUuid}_session_${sessionId}`
}

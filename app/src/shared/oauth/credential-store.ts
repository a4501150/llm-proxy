import fs from 'fs'
import path from 'path'
import { logger } from '../../logger'
import type { OAuthProviderId, ProviderCredentials } from './types'

const CREDENTIALS_DIR = 'config'

function getProviderPath(providerId: OAuthProviderId): string {
  return path.join(process.cwd(), CREDENTIALS_DIR, `${providerId}-oauth.json`)
}

export class CredentialStore {
  private cache = new Map<OAuthProviderId, ProviderCredentials>()

  /**
   * Load credentials for a specific provider from its file.
   */
  private load(providerId: OAuthProviderId): ProviderCredentials | null {
    if (this.cache.has(providerId)) return this.cache.get(providerId)!

    try {
      const filePath = getProviderPath(providerId)
      if (!fs.existsSync(filePath)) return null

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ProviderCredentials
      this.cache.set(providerId, data)
      return data
    } catch (err) {
      logger.debug(`Failed to load ${providerId} OAuth credentials`, { error: (err as Error).message })
      return null
    }
  }

  /**
   * Save credentials for a specific provider to its own file.
   */
  private save(providerId: OAuthProviderId, credentials: ProviderCredentials): void {
    try {
      const filePath = getProviderPath(providerId)
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(filePath, JSON.stringify(credentials, null, 2), { mode: 0o600 })
      logger.info(`OAuth credentials saved for ${providerId}`, { path: filePath })
    } catch (err) {
      logger.error(`Failed to save ${providerId} OAuth credentials`, { error: (err as Error).message })
    }
  }

  get(providerId: OAuthProviderId): ProviderCredentials | null {
    return this.load(providerId)
  }

  set(providerId: OAuthProviderId, credentials: ProviderCredentials): void {
    this.cache.set(providerId, credentials)
    this.save(providerId, credentials)
  }

  delete(providerId: OAuthProviderId): void {
    this.cache.delete(providerId)
    try {
      const filePath = getProviderPath(providerId)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        logger.info(`OAuth credentials deleted for ${providerId}`)
      }
    } catch (err) {
      logger.error(`Failed to delete ${providerId} OAuth credentials`, { error: (err as Error).message })
    }
  }

  has(providerId: OAuthProviderId): boolean {
    return this.get(providerId) !== null
  }

  invalidateCache(): void {
    this.cache.clear()
  }
}

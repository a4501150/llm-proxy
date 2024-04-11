/**
 * Generic client cache factory for provider SDKs
 * Eliminates duplication of caching logic between providers
 */

import { logger } from '../logger'

/**
 * Client cache interface returned by createClientCache
 */
export interface ClientCache<T> {
  /**
   * Get or create a cached client for the given project/location
   */
  get(project: string, location: string): T

  /**
   * Get the current cache size
   */
  size(): number
}

/**
 * Factory function to create a typed client cache
 *
 * @param providerName - Name used in log messages (e.g., 'AnthropicVertex', 'GoogleGenAI')
 * @param factory - Function that creates a new client instance
 * @returns ClientCache object with get and size methods
 */
export function createClientCache<T>(
  providerName: string,
  factory: (project: string, location: string) => T
): ClientCache<T> {
  const cache = new Map<string, T>()

  return {
    get(project: string, location: string): T {
      const key = `${project}:${location}`
      let client = cache.get(key)

      if (!client) {
        client = factory(project, location)
        cache.set(key, client)
        logger.info(`Created ${providerName} client`, {
          project,
          location,
          cacheSize: cache.size
        })
      }

      return client
    },

    size(): number {
      return cache.size
    }
  }
}

import { Agent, setGlobalDispatcher } from 'undici'
import { logger } from '../logger'
import { CONNECTION_POOL_CONFIG } from './constants'

// Create shared agent for connection pooling
export const sharedAgent = new Agent(CONNECTION_POOL_CONFIG)

/**
 * Initialize connection pooling globally.
 * Sets the global dispatcher for fetch (required for @google-cloud/vertexai).
 */
export function initializeConnectionPool(): void {
  setGlobalDispatcher(sharedAgent)
  logger.info('Connection pool initialized', CONNECTION_POOL_CONFIG)
}

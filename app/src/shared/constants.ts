/**
 * Shared constants for the Vertex AI proxy
 * Centralizes magic numbers and strings for maintainability
 */

// Default values for model parameters
export const DEFAULT_MAX_TOKENS = 8192

// Claude API method suffixes
export const CLAUDE_STREAM_METHOD = 'streamRawPredict'
export const CLAUDE_NON_STREAM_METHOD = 'rawPredict'

// Gemini API method suffixes
export const GEMINI_STREAM_METHOD = 'streamGenerateContent'
export const GEMINI_NON_STREAM_METHOD = 'generateContent'

// Connection pool configuration
export const CONNECTION_POOL_CONFIG = {
  keepAliveTimeout: 30_000, // 30 seconds
  keepAliveMaxTimeout: 600_000, // 10 minutes
  connections: 100,
  pipelining: 1
} as const

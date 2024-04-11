/**
 * Test fixtures and mock data
 */

import type { UserConfig } from '../../src/declarations'

// Valid user configuration for testing
export const mockUsers: UserConfig[] = [
  { username: 'testuser1', secret: 'test-secret-1' },
  { username: 'testuser2', secret: 'test-secret-2' }
]

// Valid vertex configuration
export const mockVertexConfig = {
  project: 'test-project',
  location: 'us-central1',
  useClientParams: false
}

// Sample Claude request body
export const mockClaudeRequestBody = {
  messages: [{ role: 'user', content: 'Hello, world!' }],
  max_tokens: 1024
}

// Sample Gemini request body
export const mockGeminiRequestBody = {
  contents: [{ role: 'user', parts: [{ text: 'Hello, world!' }] }],
  generationConfig: {
    maxOutputTokens: 1024,
    temperature: 0.7
  }
}

// Sample Gemini tools for transformTools testing
export const mockGeminiTools = [
  {
    functionDeclarations: [
      {
        name: 'get_weather',
        description: 'Get the weather for a location',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'The city and state'
            }
          },
          required: ['location']
        }
      }
    ]
  }
]

// Expected transformed tools (parameters -> parametersJsonSchema)
export const expectedTransformedTools = [
  {
    functionDeclarations: [
      {
        name: 'get_weather',
        description: 'Get the weather for a location',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'The city and state'
            }
          },
          required: ['location']
        }
      }
    ]
  }
]

// Sample headers for testing
export const mockHeaders = {
  authorization: 'Bearer test-secret-1',
  'content-type': 'application/json',
  'x-custom-header': 'custom-value',
  'x-forwarded-for': '192.168.1.100, 10.0.0.1'
}

// Express request mock helpers
export function createMockRequest(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    params: {},
    body: {},
    socket: { remoteAddress: '127.0.0.1' },
    app: {
      get: (key: string) => {
        if (key === 'users') return mockUsers
        if (key === 'vertex') return mockVertexConfig
        return undefined
      }
    },
    ...overrides
  }
}

// Express response mock
export function createMockResponse() {
  const headers: Record<string, string> = {}
  let statusCode = 200
  let jsonData: unknown = null
  let ended = false

  return {
    statusCode,
    setHeader: (key: string, value: string) => {
      headers[key] = value
    },
    getHeader: (key: string) => headers[key],
    status: function (code: number) {
      statusCode = code
      this.statusCode = code
      return this
    },
    json: function (data: unknown) {
      jsonData = data
      return this
    },
    end: () => {
      ended = true
    },
    headersSent: false,
    // Test helpers
    _getHeaders: () => headers,
    _getStatusCode: () => statusCode,
    _getJson: () => jsonData,
    _isEnded: () => ended
  }
}

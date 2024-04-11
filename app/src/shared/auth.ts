import express from 'express'
import { logger } from '../logger'
import type { UserConfig } from '../declarations'

// --- Authentication Result Types ---

export interface AuthSuccess {
  success: true
  username: string
  token: string
}

export interface AuthFailure {
  success: false
  statusCode: number
  error: string
  message?: string
}

export type AuthResult = AuthSuccess | AuthFailure

/**
 * Find username from secret token
 */
export function findUsername(users: UserConfig[], token: string): string {
  const user = users.find((u) => u.secret === token)
  return user?.username || 'unknown'
}

/**
 * Validate authentication and extract user info
 * Shared between Vertex AI proxy and OpenAI-compatible endpoints
 */
export function validateAuthentication(
  req: express.Request,
  requestId: string,
  clientIP: string
): AuthResult {
  const users: UserConfig[] | undefined = req.app.get('users')

  // Validate users configuration
  if (!users || !Array.isArray(users)) {
    logger.error('Configuration error: users array is not configured', {
      requestId,
      usersType: typeof users
    })
    return {
      success: false,
      statusCode: 500,
      error: 'Server configuration error',
      message: 'User authentication is not configured. Check config/default.json'
    }
  }

  if (users.length === 0) {
    logger.error('Configuration error: users array is empty', { requestId })
    return {
      success: false,
      statusCode: 500,
      error: 'Server configuration error',
      message: 'No users configured. Add users to config/default.json'
    }
  }

  // Validate authorization header
  const authHeader = req.headers.authorization
  if (!authHeader) {
    logger.warn('Missing authorization header', { requestId, clientIP })
    return {
      success: false,
      statusCode: 401,
      error: 'Authorization header required'
    }
  }

  const token = authHeader.split(' ')[1]
  const user = users.find((u) => u.secret === token)

  if (!user) {
    logger.warn('Invalid authentication token', { requestId, clientIP })
    return {
      success: false,
      statusCode: 401,
      error: 'Invalid token'
    }
  }

  return { success: true, username: user.username || 'unknown', token }
}

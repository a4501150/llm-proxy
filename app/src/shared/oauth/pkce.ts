/**
 * PKCE utilities using Web Crypto API.
 * Works in Node.js 20+ and browsers.
 */

import crypto from 'crypto'

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(32))
}

export function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(verifier)
  return base64url(hash.digest())
}

export function generateState(): string {
  return base64url(crypto.randomBytes(32))
}

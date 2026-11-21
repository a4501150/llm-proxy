import type { Application } from '../declarations.js'
import { createReverseProxy } from '../shared/reverse-proxy.js'

const googleProxyHandler = createReverseProxy({
  providerId: 'google',
  upstreamBaseUrl: 'https://generativelanguage.googleapis.com',
  stripPrefix: '/google',
  requestIdPrefix: 'google'
})

// Vertex AI Gemini passthrough for clients that build Vertex-style URLs
// (freecode's Gemini adapter). Client auth is not validated against proxy
// users because such clients have no proxy user secret — they just send a
// placeholder bearer. The client token is stripped, and the proxy's own
// google-provider OAuth token (refreshed on 401/403) is used upstream.
const vertexGeminiProxyHandler = createReverseProxy({
  providerId: 'google',
  upstreamBaseUrl: 'https://aiplatform.googleapis.com',
  stripPrefix: '/vertex-gemini',
  requestIdPrefix: 'vertex-gemini',
  skipClientAuth: true
})

export const setupGoogleDirectProxy = (app: Application): void => {
  app.use('/google', googleProxyHandler)
  app.use('/vertex-gemini', vertexGeminiProxyHandler)
}

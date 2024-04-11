import type { Application } from '../declarations.js'
import { createReverseProxy } from '../shared/reverse-proxy.js'

const chatgptProxyHandler = createReverseProxy({
  providerId: 'openai',
  upstreamBaseUrl: 'https://chatgpt.com/backend-api',
  stripPrefix: '/chatgpt',
  requestIdPrefix: 'chatgpt',
  extraHeaders: (_req, credentials): Record<string, string> => {
    const accountId = credentials.extra?.accountId
    if (typeof accountId === 'string' && accountId.length > 0) {
      return { 'chatgpt-account-id': accountId }
    }
    return {}
  }
})

export const setupChatGPTProxy = (app: Application): void => {
  app.use('/chatgpt', chatgptProxyHandler)
}

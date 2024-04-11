import type { Application } from '../declarations.js'
import { createReverseProxy } from '../shared/reverse-proxy.js'

const openaiProxyHandler = createReverseProxy({
  providerId: 'openai',
  upstreamBaseUrl: 'https://api.openai.com',
  stripPrefix: '/openai',
  requestIdPrefix: 'openai'
})

export const setupOpenAIDirectProxy = (app: Application): void => {
  app.use('/openai', openaiProxyHandler)
}

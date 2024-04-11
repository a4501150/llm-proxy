import type { Application } from '../declarations.js'
import { createReverseProxy } from '../shared/reverse-proxy.js'

const googleProxyHandler = createReverseProxy({
  providerId: 'google',
  upstreamBaseUrl: 'https://generativelanguage.googleapis.com',
  stripPrefix: '/google',
  requestIdPrefix: 'google'
})

export const setupGoogleDirectProxy = (app: Application): void => {
  app.use('/google', googleProxyHandler)
}

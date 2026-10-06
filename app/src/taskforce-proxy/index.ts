import type { Application } from '../declarations.js'
import { createReverseProxy } from '../shared/reverse-proxy.js'

/**
 * Dumb passthrough to the Hendrix GenAI gateway's generic taskforce routes.
 * One mount forwards everything: /taskforce/v1/messages (Anthropic format)
 * and /taskforce/v1/chat/completions (OpenAI format), both dispatching to
 * the taskforce-hosted model named in the request body. Unknown models and
 * paths pass through to the gateway's own 404.
 */
const taskforceHandler = createReverseProxy({
  providerId: 'taskforce',
  upstreamBaseUrl: 'https://hendrix-genai.spotify.net/taskforce',
  stripPrefix: '/taskforce',
  requestIdPrefix: 'taskforce'
})

export const setupTaskforceProxy = (app: Application): void => {
  app.use('/taskforce', taskforceHandler)
}

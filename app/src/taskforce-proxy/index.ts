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

/**
 * Same passthrough for the Snipe dedicated route (/snipe/hendrix), which
 * serves the same self-hosted models (deployment picked from the body model)
 * with lighter gateway constraints: 900s read timeout (taskforce: 300s),
 * two retries, and the target circuit breaker disabled — gate sheds surface
 * as 503s instead of breaker-ejected 502s. Same VAK auth as /taskforce.
 */
const snipeHandler = createReverseProxy({
  providerId: 'taskforce',
  upstreamBaseUrl: 'https://hendrix-genai.spotify.net/snipe/hendrix',
  stripPrefix: '/snipe',
  requestIdPrefix: 'snipe'
})

export const setupTaskforceProxy = (app: Application): void => {
  app.use('/taskforce', taskforceHandler)
  app.use('/snipe', snipeHandler)
}

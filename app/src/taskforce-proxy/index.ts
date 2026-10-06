import type { Application } from '../declarations.js'
import { createReverseProxy } from '../shared/reverse-proxy.js'

const HENDRIX_BASE = 'https://hendrix-genai.spotify.net'

/**
 * Dumb passthrough to the Hendrix GenAI gateway model-dispatch route.
 * One mount, any taskforce-hosted model, selected by the model field in
 * the request body (the gateway 404s unknown ids). The public path stays
 * /taskforce/hendrix; /snipe/hendrix is the gateway's own naming.
 */
const hendrixHandler = createReverseProxy({
  providerId: 'taskforce',
  upstreamBaseUrl: `${HENDRIX_BASE}/snipe/hendrix`,
  stripPrefix: '/taskforce/hendrix',
  requestIdPrefix: 'taskforce'
})

export const setupTaskforceProxy = (app: Application): void => {
  app.use('/taskforce/hendrix', hendrixHandler)
}

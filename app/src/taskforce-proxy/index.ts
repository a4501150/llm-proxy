import type { Application } from '../declarations.js'
import { createReverseProxy } from '../shared/reverse-proxy.js'

const HENDRIX_BASE = 'https://hendrix-genai.spotify.net'

/**
 * Dumb passthroughs to the Hendrix GenAI gateway taskforce routes.
 * One mount per deployment; the gateway 404s when the body model does not
 * match the path, so clients must name the model their endpoint hosts.
 */
function taskforceProxy(model: string) {
  return createReverseProxy({
    providerId: 'taskforce',
    upstreamBaseUrl: `${HENDRIX_BASE}/taskforce/${model}`,
    stripPrefix: `/taskforce/${model}`,
    requestIdPrefix: 'taskforce'
  })
}

const glm53Handler = taskforceProxy('glm-5-3')
const glm53FlashHandler = taskforceProxy('glm-5-3-flash')

export const setupTaskforceProxy = (app: Application): void => {
  // Express matches whole path segments, so '/taskforce/glm-5-3' never
  // swallows '/taskforce/glm-5-3-flash'; flash is registered first anyway.
  app.use('/taskforce/glm-5-3-flash', glm53FlashHandler)
  app.use('/taskforce/glm-5-3', glm53Handler)
}

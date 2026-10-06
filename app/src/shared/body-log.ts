import type express from 'express'
import { logger } from '../logger'
import { logFlags } from './runtime-config'

/**
 * Detailed request/response body logging, gated by the live logBodies flag
 * (homepage toggle / runtime-overrides.json). Bodies are logged in full —
 * including streamed SSE responses — so this can put prompts and tokens
 * into the logs.
 */

export function logRequestBody(label: string, requestId: string, body: unknown): void {
  if (!logFlags.bodies) return
  logger.debug(`${label} request body`, { requestId, body: JSON.stringify(body) })
}

/**
 * Tee everything the handler writes to the client and log it at finish.
 * Call once near the top of a handler, before the response is produced.
 */
export function captureResponseBody(res: express.Response, requestId: string, label: string): void {
  if (!logFlags.bodies) return

  const chunks: string[] = []
  const push = (chunk: unknown): void => {
    if (chunk == null) return
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString())
  }

  const origWrite = res.write.bind(res) as (chunk: any, ...args: any[]) => boolean
  const origEnd = res.end.bind(res) as (...args: any[]) => express.Response

  res.write = ((chunk: any, ...args: any[]) => {
    push(chunk)
    return origWrite(chunk, ...args)
  }) as typeof res.write

  res.end = ((chunk?: any, ...args: any[]) => {
    push(chunk)
    logger.debug(`${label} response body`, { requestId, body: chunks.join('') })
    return origEnd(chunk, ...args)
  }) as typeof res.end
}

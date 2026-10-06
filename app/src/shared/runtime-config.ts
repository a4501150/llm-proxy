import fs from 'fs'
import path from 'path'
import { logger } from '../logger'
import type { Application, UserConfig, VertexConfig } from '../declarations'

/**
 * UI-managed config overrides, persisted separately from config/default.json.
 *
 * node-config caches the files it read at startup, so a file write into
 * config/ is never re-read; instead every consumer reads users/vertex via
 * req.app.get per request, and applyOverrides() puts these values into the
 * app settings on top of the node-config ones. A restart replays this file,
 * so runtime edits survive deploys. Mirrors credential-store.ts (same dir,
 * mode 0600) but writes via tmp-file+rename.
 */

export interface LogSettings {
  level?: 'error' | 'warn' | 'info' | 'debug'
  logBodies?: boolean
}

export interface RuntimeOverrides {
  users?: UserConfig[]
  vertex?: VertexConfig
  logging?: LogSettings
}

// Mutable flags consulted at logging seams; hydrated by applyOverrides and
// flipped live by the config API.
export const logFlags = {
  bodies: false
}

const OVERRIDES_FILE = 'runtime-overrides.json'

function overridesPath(): string {
  return process.env.PROXY_OVERRIDES_PATH || path.join(process.cwd(), 'config', OVERRIDES_FILE)
}

let state: RuntimeOverrides = {}

function readState(): RuntimeOverrides {
  try {
    const filePath = overridesPath()
    if (!fs.existsSync(filePath)) return {}
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RuntimeOverrides
  } catch (err) {
    logger.warn('Failed to load runtime overrides, using base config', {
      error: (err as Error).message
    })
    return {}
  }
}

function writeState(overrides: RuntimeOverrides): void {
  const filePath = overridesPath()
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(overrides, null, 2), { mode: 0o600 })
  fs.renameSync(tmpPath, filePath)
}

/** Apply persisted overrides (if any) on top of the node-config settings. */
export function applyOverrides(app: Application): void {
  state = readState()

  if (state.users && state.users.length > 0) {
    app.set('users', state.users)
  }
  if (state.vertex) {
    app.set('vertex', state.vertex)
  }
  if (state.logging?.level) {
    logger.level = state.logging.level
  }
  if (state.logging?.logBodies !== undefined) {
    logFlags.bodies = state.logging.logBodies
  }

  logger.debug('Runtime config overrides applied', {
    path: overridesPath(),
    keys: Object.keys(state)
  })
}

export function getOverrides(): RuntimeOverrides {
  return state
}

/** Merge a patch into the overrides, persist, and return the new state. */
export function saveOverrides(patch: RuntimeOverrides): RuntimeOverrides {
  state = {
    ...state,
    ...patch,
    logging: patch.logging ? { ...state.logging, ...patch.logging } : state.logging
  }
  writeState(state)
  logger.info('Runtime config overrides saved', { keys: Object.keys(patch) })
  return state
}

/** Apply a logging patch to the live process (level + body capture flag). */
export function applyLogSettings(logging: LogSettings): void {
  if (logging.level) {
    logger.level = logging.level
  }
  if (logging.logBodies !== undefined) {
    logFlags.bodies = logging.logBodies
  }
}

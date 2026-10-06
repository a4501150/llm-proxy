import type express from 'express'
import type { Application, UserConfig, VertexConfig } from '../declarations.js'
import { logger } from '../logger.js'
import { validateAuthentication } from '../shared/auth.js'
import {
  applyLogSettings,
  getOverrides,
  logFlags,
  saveOverrides,
  type LogSettings
} from '../shared/runtime-config.js'
import { renderHomePage } from './page.js'
import type { PublicState } from './state.js'

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const

function maskSecret(secret: string): string {
  if (secret.length <= 4) return '••••'
  return `${secret.slice(0, 3)}…${secret.slice(-2)}`
}

function publicState(app: Application): PublicState {
  const users = (app.get('users') ?? []) as UserConfig[]
  const vertex = (app.get('vertex') ?? { project: '', location: '' }) as VertexConfig
  return {
    users: users.map((u) => ({ username: u.username, maskedSecret: maskSecret(u.secret) })),
    vertex,
    logging: { level: logger.level, logBodies: logFlags.bodies }
  }
}

/**
 * Merge submitted users into the current list. A blank secret on a username
 * that already exists keeps the stored secret; new users must carry one.
 */
function resolveUsers(app: Application, submitted: unknown): { users?: UserConfig[]; error?: string } {
  if (!Array.isArray(submitted) || submitted.length === 0) {
    return { error: 'users must be a non-empty array (refusing to remove the last user)' }
  }
  const current = (app.get('users') ?? []) as UserConfig[]
  const seen = new Set<string>()
  const users: UserConfig[] = []
  for (const entry of submitted) {
    const username = typeof entry?.username === 'string' ? entry.username.trim() : ''
    const secret = typeof entry?.secret === 'string' ? entry.secret : ''
    if (!username) return { error: 'every user needs a username' }
    if (seen.has(username)) return { error: `duplicate username: ${username}` }
    seen.add(username)
    const existing = current.find((u) => u.username === username)
    if (!secret && !existing) {
      return { error: `new user ${username} needs a secret` }
    }
    users.push({ username, secret: secret || existing!.secret })
  }
  return { users }
}

function putConfig(
  app: Application,
  req: express.Request,
  res: express.Response,
  authUsername: string
): void {
  const body = req.body ?? {}

  if (body.users !== undefined) {
    const { users, error } = resolveUsers(app, body.users)
    if (error) {
      res.status(400).json({ error })
      return
    }
    app.set('users', users!)
  }

  if (body.vertex !== undefined) {
    const v = body.vertex
    if (typeof v?.project !== 'string' || typeof v?.location !== 'string') {
      res.status(400).json({ error: 'vertex.project and vertex.location must be strings' })
      return
    }
    const vertex: VertexConfig = {
      project: v.project.trim(),
      location: v.location.trim(),
      useClientParams: v.useClientParams === true
    }
    app.set('vertex', vertex)
  }

  if (body.logging !== undefined) {
    const l = body.logging
    if (l.level !== undefined && !LOG_LEVELS.includes(l.level)) {
      res.status(400).json({ error: `logging.level must be one of: ${LOG_LEVELS.join(', ')}` })
      return
    }
    if (l.logBodies !== undefined && typeof l.logBodies !== 'boolean') {
      res.status(400).json({ error: 'logging.logBodies must be a boolean' })
      return
    }
    applyLogSettings(l)
  }

  saveOverrides({
    ...(body.users !== undefined ? { users: app.get('users') as UserConfig[] } : {}),
    ...(body.vertex !== undefined ? { vertex: app.get('vertex') as VertexConfig } : {}),
    ...(body.logging !== undefined
      ? { logging: { level: logger.level as LogSettings['level'], logBodies: logFlags.bodies } }
      : {})
  })
  logger.info('Config updated via homepage', { keys: Object.keys(body), user: authUsername })
  res.json(publicState(app))
}

export const setupHomepage = (app: Application): void => {
  const expressApp = app as unknown as express.Application

  expressApp.get('/', (req: express.Request, res: express.Response) => {
    const app = req.app as unknown as Application
    res.type('html').send(renderHomePage(publicState(app), getOverrides()))
  })

  expressApp.get('/api/config', (req: express.Request, res: express.Response) => {
    res.json(publicState(req.app as unknown as Application))
  })

  expressApp.put('/api/config', (req: express.Request, res: express.Response) => {
    const authResult = validateAuthentication(req, 'home-config', req.socket.remoteAddress || 'unknown')
    if (!authResult.success) {
      res.status(authResult.statusCode).json({ error: authResult.error })
      return
    }
    putConfig(req.app as unknown as Application, req, res, authResult.username)
  })
}

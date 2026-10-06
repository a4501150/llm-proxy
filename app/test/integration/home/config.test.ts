/**
 * Integration tests for the homepage config API (GET /api/config, PUT /api/config)
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { expect } from '../../setup'
import request from 'supertest'
import express, { json } from 'express'
import type { Application } from '../../../src/declarations'
import { setupHomepage } from '../../../src/home'
import { logger } from '../../../src/logger'
import { getOverrides, logFlags } from '../../../src/shared/runtime-config'
import { mockUsers, mockVertexConfig } from '../../fixtures/mock-data'

const AUTH = { Authorization: 'Bearer test-secret-1' }

describe('Homepage config API', () => {
  let app: express.Application
  let overridesFile: string
  const originalLevel = logger.level
  const originalBodies = logFlags.bodies

  beforeEach(() => {
    overridesFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-overrides-')),
      'runtime-overrides.json'
    )
    process.env.PROXY_OVERRIDES_PATH = overridesFile

    app = express()
    app.use(json())
    app.set('users', mockUsers)
    app.set('vertex', mockVertexConfig)
    setupHomepage(app as unknown as Application)
  })

  afterEach(() => {
    logger.level = originalLevel
    logFlags.bodies = originalBodies
    delete process.env.PROXY_OVERRIDES_PATH
  })

  describe('GET /', () => {
    it('serves the homepage', async () => {
      const res = await request(app).get('/')
      expect(res.status).to.equal(200)
      expect(res.text).to.contain('LLM Proxy')
      expect(res.text).to.contain('/api/config')
    })
  })

  describe('GET /api/config', () => {
    it('masks user secrets', async () => {
      const res = await request(app).get('/api/config')
      expect(res.status).to.equal(200)
      expect(res.body.users).to.have.lengthOf(2)
      for (const user of res.body.users) {
        expect(JSON.stringify(user)).to.not.contain('test-secret')
        expect(user.maskedSecret).to.contain('…')
      }
    })
  })

  describe('PUT /api/config', () => {
    it('requires authentication', async () => {
      const res = await request(app).put('/api/config').send({ logging: { level: 'debug' } })
      expect(res.status).to.equal(401)
    })

    it('applies vertex updates immediately and persists them', async () => {
      const res = await request(app)
        .put('/api/config')
        .set(AUTH)
        .send({ vertex: { project: 'new-project', location: 'europe-west1', useClientParams: true } })

      expect(res.status).to.equal(200)
      expect(app.get('vertex')).to.deep.include({ project: 'new-project', location: 'europe-west1' })

      const persisted = JSON.parse(fs.readFileSync(overridesFile, 'utf-8'))
      expect(persisted.vertex.project).to.equal('new-project')
    })

    it('rejects an empty users list (lockout guard)', async () => {
      const res = await request(app).put('/api/config').set(AUTH).send({ users: [] })
      expect(res.status).to.equal(400)
      expect(app.get('users')).to.have.lengthOf(2)
    })

    it('rejects a new user without a secret', async () => {
      const res = await request(app)
        .put('/api/config')
        .set(AUTH)
        .send({ users: [{ username: 'testuser1', secret: '' }, { username: 'newbie', secret: '' }] })
      expect(res.status).to.equal(400)
    })

    it('keeps the stored secret when a blank secret is submitted for an existing user', async () => {
      const res = await request(app)
        .put('/api/config')
        .set(AUTH)
        .send({
          users: [
            { username: 'testuser1', secret: '' },
            { username: 'newbie', secret: 'brand-new-secret' }
          ]
        })

      expect(res.status).to.equal(200)
      const users = app.get('users') as typeof mockUsers
      expect(users.find((u) => u.username === 'testuser1')?.secret).to.equal('test-secret-1')
      expect(users.find((u) => u.username === 'newbie')?.secret).to.equal('brand-new-secret')
    })

    it('rejects duplicate usernames', async () => {
      const res = await request(app)
        .put('/api/config')
        .set(AUTH)
        .send({
          users: [
            { username: 'dup', secret: 'a' },
            { username: 'dup', secret: 'b' }
          ]
        })
      expect(res.status).to.equal(400)
    })

    it('toggles logging level and body capture live', async () => {
      const res = await request(app)
        .put('/api/config')
        .set(AUTH)
        .send({ logging: { level: 'debug', logBodies: true } })

      expect(res.status).to.equal(200)
      expect(logger.level).to.equal('debug')
      expect(logFlags.bodies).to.equal(true)

      const persisted = JSON.parse(fs.readFileSync(overridesFile, 'utf-8'))
      expect(persisted.logging).to.deep.equal({ level: 'debug', logBodies: true })
      expect(getOverrides().logging).to.deep.equal({ level: 'debug', logBodies: true })
    })

    it('rejects an unknown log level', async () => {
      const res = await request(app).put('/api/config').set(AUTH).send({ logging: { level: 'trace' } })
      expect(res.status).to.equal(400)
    })
  })
})

/**
 * Integration tests for OpenAI-compatible chat completions endpoint
 */

import { expect } from '../../setup'
import request from 'supertest'
import express from 'express'
import { json } from 'express'
import sinon from 'sinon'
import { chatCompletionsHandler } from '../../../src/openai/chat-completions'
import { mockUsers, mockVertexConfig } from '../../fixtures/mock-data'

// Mock OpenAI request body
const mockOpenAIRequest = {
  model: 'claude-3-opus',
  messages: [{ role: 'user', content: 'Hello, world!' }]
}

describe('OpenAI Chat Completions', () => {
  let app: express.Application

  beforeEach(() => {
    app = express()
    app.use(json())

    // Set up default configuration
    app.set('users', mockUsers)
    app.set('vertex', mockVertexConfig)

    // Register the chat completions endpoint
    app.post('/v1/chat/completions', chatCompletionsHandler)
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('Authentication', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const response = await request(app).post('/v1/chat/completions').send(mockOpenAIRequest)

      expect(response.status).to.equal(401)
      expect(response.body.error).to.exist
      expect(response.body.error.message).to.equal('Authorization header required')
      expect(response.body.error.type).to.equal('authentication_error')
    })

    it('should return 401 when token is invalid', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer invalid-token')
        .send(mockOpenAIRequest)

      expect(response.status).to.equal(401)
      expect(response.body.error.message).to.equal('Invalid token')
      expect(response.body.error.type).to.equal('authentication_error')
    })
  })

  describe('Provider Header Validation', () => {
    it('should return 400 when X-LLM-Provider header is missing', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .send(mockOpenAIRequest)

      expect(response.status).to.equal(400)
      expect(response.body.error.message).to.include('X-LLM-Provider')
    })

    it('should return 400 when X-LLM-Provider header is invalid', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'invalid-provider')
        .send(mockOpenAIRequest)

      expect(response.status).to.equal(400)
      expect(response.body.error.message).to.include('X-LLM-Provider')
    })
  })

  describe('Request Validation', () => {
    it('should return 400 when model is missing', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'vertex-ai')
        .send({ messages: [{ role: 'user', content: 'Hello' }] })

      expect(response.status).to.equal(400)
      expect(response.body.error.message).to.include('model')
      expect(response.body.error.type).to.equal('invalid_request_error')
    })

    it('should return 400 when messages is missing', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'vertex-ai')
        .send({ model: 'claude-3-opus' })

      expect(response.status).to.equal(400)
      expect(response.body.error.message).to.include('messages')
      expect(response.body.error.type).to.equal('invalid_request_error')
    })

    it('should return 400 when messages array is empty', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'vertex-ai')
        .send({ model: 'claude-3-opus', messages: [] })

      expect(response.status).to.equal(400)
      expect(response.body.error.message).to.include('empty')
      expect(response.body.error.type).to.equal('invalid_request_error')
    })

    it('should return 400 when message role is invalid', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'vertex-ai')
        .send({
          model: 'claude-3-opus',
          messages: [{ role: 'invalid', content: 'Hello' }]
        })

      expect(response.status).to.equal(400)
      expect(response.body.error.message).to.include('role')
      expect(response.body.error.type).to.equal('invalid_request_error')
    })

    it('should return 400 when tool message is missing tool_call_id', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'vertex-ai')
        .send({
          model: 'claude-3-opus',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'tool', content: 'result' }
          ]
        })

      expect(response.status).to.equal(400)
      expect(response.body.error.message).to.include('tool_call_id')
      expect(response.body.error.type).to.equal('invalid_request_error')
    })
  })

  describe('Model Routing (vertex-ai provider)', function () {
    this.timeout(10000)

    it('should return 400 for unsupported model prefix with vertex-ai provider', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'vertex-ai')
        .send({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }]
        })

      expect(response.status).to.equal(400)
      expect(response.body.error.message).to.include('Unsupported model')
      expect(response.body.error.message).to.include('gpt-4')
      expect(response.body.error.code).to.equal('model_not_found')
    })

    it('should accept claude models with vertex-ai provider', async () => {
      // This will fail at the SDK level but should pass routing
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'vertex-ai')
        .send({
          model: 'claude-3-opus',
          messages: [{ role: 'user', content: 'Hello' }]
        })

      // Should not be a routing error
      expect(response.body.error?.code).to.not.equal('model_not_found')
    })

    it('should accept gemini models with vertex-ai provider', async () => {
      // This will fail at the SDK level but should pass routing
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'vertex-ai')
        .send({
          model: 'gemini-1.5-pro',
          messages: [{ role: 'user', content: 'Hello' }]
        })

      // Should not be a routing error
      expect(response.body.error?.code).to.not.equal('model_not_found')
    })
  })

  describe('Configuration', () => {
    it('should return 500 when vertex config is missing for vertex-ai provider', async () => {
      app.set('vertex', null)

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'vertex-ai')
        .send(mockOpenAIRequest)

      expect(response.status).to.equal(500)
      expect(response.body.error.message).to.include('configuration')
      expect(response.body.error.type).to.equal('server_error')
    })

    it('should return 500 when vertex project is missing for vertex-ai provider', async () => {
      app.set('vertex', { location: 'us-central1' })

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${mockUsers[0].secret}`)
        .set('X-LLM-Provider', 'vertex-ai')
        .send(mockOpenAIRequest)

      expect(response.status).to.equal(500)
      expect(response.body.error.type).to.equal('server_error')
    })
  })

  describe('Request ID Header', () => {
    it('should include X-Request-Id in response headers', async () => {
      const response = await request(app).post('/v1/chat/completions').send(mockOpenAIRequest)

      expect(response.headers['x-request-id']).to.match(/^req-/)
    })
  })

  describe('Error Response Format', () => {
    it('should return OpenAI-compatible error format', async () => {
      const response = await request(app).post('/v1/chat/completions').send(mockOpenAIRequest)

      expect(response.body).to.have.property('error')
      expect(response.body.error).to.have.property('message')
      expect(response.body.error).to.have.property('type')
      expect(response.body.error).to.have.property('param')
      expect(response.body.error).to.have.property('code')
    })
  })
})

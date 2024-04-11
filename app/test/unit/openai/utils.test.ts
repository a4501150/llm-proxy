import { expect } from 'chai'
import {
  generateCompletionId,
  generateToolCallId,
  generateRequestId,
  getCurrentTimestamp,
  mapClaudeFinishReason,
  mapGeminiFinishReason,
  getClientIP,
  mapStatusToErrorType
} from '../../../src/openai/utils'

describe('OpenAI Utils', () => {
  describe('generateCompletionId', () => {
    it('should generate ID with chatcmpl- prefix', () => {
      const id = generateCompletionId()
      expect(id).to.match(/^chatcmpl-/)
    })

    it('should generate unique IDs', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 100; i++) {
        ids.add(generateCompletionId())
      }
      expect(ids.size).to.equal(100)
    })
  })

  describe('generateToolCallId', () => {
    it('should generate ID with call_ prefix', () => {
      const id = generateToolCallId()
      expect(id).to.match(/^call_/)
    })

    it('should generate unique IDs', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 100; i++) {
        ids.add(generateToolCallId())
      }
      expect(ids.size).to.equal(100)
    })
  })

  describe('generateRequestId', () => {
    it('should generate ID with req- prefix', () => {
      const id = generateRequestId()
      expect(id).to.match(/^req-/)
    })

    it('should include timestamp', () => {
      const before = Date.now()
      const id = generateRequestId()
      const after = Date.now()

      const parts = id.split('-')
      const timestamp = parseInt(parts[1], 10)
      expect(timestamp).to.be.at.least(before)
      expect(timestamp).to.be.at.most(after)
    })
  })

  describe('getCurrentTimestamp', () => {
    it('should return current Unix timestamp in seconds', () => {
      const before = Math.floor(Date.now() / 1000)
      const timestamp = getCurrentTimestamp()
      const after = Math.floor(Date.now() / 1000)

      expect(timestamp).to.be.at.least(before)
      expect(timestamp).to.be.at.most(after)
    })

    it('should return an integer', () => {
      const timestamp = getCurrentTimestamp()
      expect(Number.isInteger(timestamp)).to.be.true
    })
  })

  describe('mapClaudeFinishReason', () => {
    it('should map end_turn to stop', () => {
      expect(mapClaudeFinishReason('end_turn')).to.equal('stop')
    })

    it('should map stop_sequence to stop', () => {
      expect(mapClaudeFinishReason('stop_sequence')).to.equal('stop')
    })

    it('should map max_tokens to length', () => {
      expect(mapClaudeFinishReason('max_tokens')).to.equal('length')
    })

    it('should map tool_use to tool_calls', () => {
      expect(mapClaudeFinishReason('tool_use')).to.equal('tool_calls')
    })

    it('should return null for null input', () => {
      expect(mapClaudeFinishReason(null)).to.be.null
    })

    it('should return null for undefined input', () => {
      expect(mapClaudeFinishReason(undefined)).to.be.null
    })

    it('should default to stop for unknown values', () => {
      expect(mapClaudeFinishReason('unknown')).to.equal('stop')
    })
  })

  describe('mapGeminiFinishReason', () => {
    it('should map STOP to stop', () => {
      expect(mapGeminiFinishReason('STOP')).to.equal('stop')
    })

    it('should map MAX_TOKENS to length', () => {
      expect(mapGeminiFinishReason('MAX_TOKENS')).to.equal('length')
    })

    it('should map SAFETY to content_filter', () => {
      expect(mapGeminiFinishReason('SAFETY')).to.equal('content_filter')
    })

    it('should map RECITATION to content_filter', () => {
      expect(mapGeminiFinishReason('RECITATION')).to.equal('content_filter')
    })

    it('should return null for null input', () => {
      expect(mapGeminiFinishReason(null)).to.be.null
    })

    it('should return null for undefined input', () => {
      expect(mapGeminiFinishReason(undefined)).to.be.null
    })

    it('should default to stop for unknown values', () => {
      expect(mapGeminiFinishReason('UNKNOWN')).to.equal('stop')
    })
  })

  describe('getClientIP', () => {
    it('should extract IP from x-forwarded-for header', () => {
      const req = {
        headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' }
      }
      expect(getClientIP(req)).to.equal('192.168.1.1')
    })

    it('should fall back to socket.remoteAddress', () => {
      const req = {
        headers: {},
        socket: { remoteAddress: '192.168.1.100' }
      }
      expect(getClientIP(req)).to.equal('192.168.1.100')
    })

    it('should return unknown when no IP available', () => {
      const req = {
        headers: {}
      }
      expect(getClientIP(req)).to.equal('unknown')
    })
  })

  describe('mapStatusToErrorType', () => {
    it('should return authentication_error for 401', () => {
      expect(mapStatusToErrorType(401)).to.equal('authentication_error')
    })

    it('should return authentication_error for 403', () => {
      expect(mapStatusToErrorType(403)).to.equal('authentication_error')
    })

    it('should return rate_limit_error for 429', () => {
      expect(mapStatusToErrorType(429)).to.equal('rate_limit_error')
    })

    it('should return invalid_request_error for 400', () => {
      expect(mapStatusToErrorType(400)).to.equal('invalid_request_error')
    })

    it('should return invalid_request_error for 404', () => {
      expect(mapStatusToErrorType(404)).to.equal('invalid_request_error')
    })

    it('should return server_error for 500', () => {
      expect(mapStatusToErrorType(500)).to.equal('server_error')
    })

    it('should return server_error for 503', () => {
      expect(mapStatusToErrorType(503)).to.equal('server_error')
    })
  })
})

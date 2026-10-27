import { expect } from 'chai'
import {
  applyClaudeAttributionToBody,
  buildJsonUserId,
  computeBillingFingerprint,
  computeCch,
  computeClaudeAttribution,
  deriveAnthropicBeta,
  ensureDeviceId,
  isConfirmedClaudeCodeClient,
  xxhash64
} from '../../../src/shared/claude-attribution.js'
import type { ProviderCredentials } from '../../../src/shared/oauth/types.js'

const ACCOUNT_UUID = '11112222-3333-4444-5555-666677778888'

function makeCredentials(): ProviderCredentials {
  return {
    accessToken: 'sk-ant-oat-test',
    refreshToken: 'rt',
    expiresAt: Date.now() + 3600_000,
    extra: {
      profile: {
        accountUuid: ACCOUNT_UUID,
        email: 'test@example.com',
        organizationUuid: 'org-1'
      }
    }
  }
}

const DEVICE_ID = 'a'.repeat(64)
const SESSION_ID = '99998888-7777-6666-5555-444433332222'

describe('Claude attribution', () => {
  describe('xxhash64', () => {
    it('matches the reference vector for empty input', () => {
      expect(xxhash64(Buffer.from(''), 0n)).to.equal(0xef46db3751d8e999n)
    })

    it('is deterministic and seed-sensitive', () => {
      const buf = Buffer.from('{"model":"","messages":[]}')
      expect(xxhash64(buf, 1n)).to.equal(xxhash64(buf, 1n))
      expect(xxhash64(buf, 1n)).to.not.equal(xxhash64(buf, 2n))
    })

    it('covers inputs shorter and longer than 32 bytes', () => {
      expect(() => xxhash64(Buffer.from('short'), 42n)).to.not.throw()
      expect(() => xxhash64(Buffer.from('x'.repeat(100)), 42n)).to.not.throw()
    })
  })

  describe('computeCch', () => {
    it('produces 5 lowercase hex digits', () => {
      const cch = computeCch({ model: 'claude-sonnet-4-5', messages: [] })
      expect(cch).to.match(/^[0-9a-f]{5}$/)
    })

    it('ignores max_tokens, fallbacks and model value', () => {
      const base = { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }
      const withNoise = {
        model: 'claude-opus-4-5',
        messages: base.messages,
        max_tokens: 4096,
        fallbacks: ['x'],
        fallback_credit_token: 'y'
      }
      expect(computeCch(base)).to.equal(computeCch(withNoise))
    })
  })

  describe('computeBillingFingerprint', () => {
    it('produces 3 hex chars and depends on sampled text positions', () => {
      expect(computeBillingFingerprint('hello world, this is a test message')).to.match(/^[0-9a-f]{3}$/)
      expect(computeBillingFingerprint('hello worXXX, this is a test message')).to.not.equal(
        computeBillingFingerprint('hello world, this is a test message')
      )
    })

    it('tolerates short or empty user text', () => {
      expect(computeBillingFingerprint('hi')).to.match(/^[0-9a-f]{3}$/)
      expect(computeBillingFingerprint('')).to.match(/^[0-9a-f]{3}$/)
    })
  })

  describe('deriveAnthropicBeta', () => {
    it('emits the OAuth baseline in wire order', () => {
      const beta = deriveAnthropicBeta({ model: 'claude-sonnet-4-5' }, { isOAuth: true })
      expect(beta).to.equal('claude-code-20250219,oauth-2025-04-20,extended-cache-ttl-2025-04-11')
    })

    it('adds conditional betas for 1m models and thinking', () => {
      const beta = deriveAnthropicBeta(
        { model: 'claude-sonnet-4-5[1m]', thinking: { type: 'enabled', budget_tokens: 1000 } },
        { isOAuth: true }
      )
      expect(beta.split(',')).to.deep.equal([
        'claude-code-20250219',
        'oauth-2025-04-20',
        'context-1m-2025-08-07',
        'interleaved-thinking-2025-05-14',
        'extended-cache-ttl-2025-04-11'
      ])
    })

    it('omits extended-cache-ttl when the body pins a 1h cache TTL', () => {
      const body = {
        model: 'claude-sonnet-4-5',
        system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }]
      }
      expect(deriveAnthropicBeta(body, { isOAuth: true })).to.not.include('extended-cache-ttl')
    })

    it('appends caller betas, then applies strip and append', () => {
      const beta = deriveAnthropicBeta(
        { model: 'claude-sonnet-4-5' },
        {
          isOAuth: true,
          callerBeta: 'prompt-caching-scope-2026-01-05, oauth-2025-04-20',
          config: {
            anthropicBetaStrip: ['extended-cache-ttl-2025-04-11'],
            anthropicBetaAppend: ['advisor-tool-2026-03-01']
          }
        }
      )
      expect(beta).to.equal(
        'claude-code-20250219,oauth-2025-04-20,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01'
      )
    })
  })

  describe('isConfirmedClaudeCodeClient', () => {
    const confirmedHeaders = {
      'x-app': 'cli',
      'user-agent': 'claude-cli/2.1.280 (external, cli)',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20'
    }
    const confirmedBody = {
      metadata: { user_id: buildJsonUserId(DEVICE_ID, ACCOUNT_UUID, SESSION_ID) }
    }

    it('accepts a full Claude Code fingerprint', () => {
      expect(isConfirmedClaudeCodeClient(confirmedHeaders, confirmedBody)).to.equal(true)
    })

    it('accepts the legacy user_id shape', () => {
      const body = {
        metadata: { user_id: `user_${DEVICE_ID}_account_${ACCOUNT_UUID}_session_${SESSION_ID}` }
      }
      expect(isConfirmedClaudeCodeClient(confirmedHeaders, body)).to.equal(true)
    })

    it('rejects when any signal is missing', () => {
      expect(
        isConfirmedClaudeCodeClient({ ...confirmedHeaders, 'x-app': undefined }, confirmedBody)
      ).to.equal(false)
      expect(
        isConfirmedClaudeCodeClient({ ...confirmedHeaders, 'user-agent': 'curl/8' }, confirmedBody)
      ).to.equal(false)
      expect(
        isConfirmedClaudeCodeClient(
          { ...confirmedHeaders, 'anthropic-beta': 'oauth-2025-04-20' },
          confirmedBody
        )
      ).to.equal(false)
      expect(isConfirmedClaudeCodeClient(confirmedHeaders, { metadata: {} })).to.equal(false)
      expect(isConfirmedClaudeCodeClient(confirmedHeaders, undefined)).to.equal(false)
    })
  })

  describe('ensureDeviceId', () => {
    it('generates a stable 64-hex device id and persists once', () => {
      const credentials = makeCredentials()
      let saves = 0
      const first = ensureDeviceId(credentials, () => saves++)
      const second = ensureDeviceId(credentials, () => saves++)
      expect(first).to.match(/^[0-9a-f]{64}$/)
      expect(second).to.equal(first)
      expect(saves).to.equal(1)
    })
  })

  describe('buildJsonUserId', () => {
    it('uses the fixed key order device_id, account_uuid, session_id', () => {
      const userId = buildJsonUserId(DEVICE_ID, ACCOUNT_UUID, SESSION_ID)
      expect(JSON.parse(userId)).to.deep.equal({
        device_id: DEVICE_ID,
        account_uuid: ACCOUNT_UUID,
        session_id: SESSION_ID
      })
      expect(Object.keys(JSON.parse(userId))).to.deep.equal(['device_id', 'account_uuid', 'session_id'])
    })

    it('preserves unknown extra keys from the caller user_id', () => {
      const caller = JSON.stringify({
        device_id: 'x',
        account_uuid: 'y',
        session_id: 'z',
        cc_source: 'proxy'
      })
      const parsed = JSON.parse(buildJsonUserId(DEVICE_ID, ACCOUNT_UUID, SESSION_ID, caller))
      expect(parsed.cc_source).to.equal('proxy')
      expect(parsed.device_id).to.equal(DEVICE_ID)
    })
  })

  describe('computeClaudeAttribution', () => {
    it('prefers the caller session id header', () => {
      const credentials = makeCredentials()
      const attribution = computeClaudeAttribution(
        { 'x-claude-code-session-id': SESSION_ID },
        { model: 'claude-sonnet-4-5' },
        credentials,
        DEVICE_ID
      )
      expect(attribution.sessionId).to.equal(SESSION_ID)
      expect(attribution.headers['x-claude-code-session-id']).to.equal(SESSION_ID)
      expect(attribution.headers['user-agent']).to.equal('claude-cli/2.1.280 (external, cli)')
      expect(attribution.headers['x-app']).to.equal('cli')
      expect(attribution.headers['x-stainless-runtime']).to.equal('node')
      expect(attribution.headers['x-client-request-id']).to.match(/^[0-9a-f-]{36}$/)
    })

    it('passes confirmed Claude Code clients through with no forced headers', () => {
      const headers = {
        'x-app': 'cli',
        'user-agent': 'claude-cli/2.1.280 (external, cli)',
        'anthropic-beta': 'claude-code-20250219'
      }
      const body = { metadata: { user_id: buildJsonUserId(DEVICE_ID, ACCOUNT_UUID, SESSION_ID) } }
      const attribution = computeClaudeAttribution(headers, body, makeCredentials(), DEVICE_ID)
      expect(attribution.confirmedClient).to.equal(true)
      expect(attribution.headers).to.deep.equal({})
    })
  })

  describe('applyClaudeAttributionToBody', () => {
    const baseBody = () => ({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'What is the capital of France?' }]
    })

    function attribute(
      body: Record<string, unknown>,
      config?: Parameters<typeof applyClaudeAttributionToBody>[4]
    ) {
      const credentials = makeCredentials()
      const attribution = computeClaudeAttribution({}, body, credentials, DEVICE_ID, config)
      return applyClaudeAttributionToBody(body, attribution, credentials, DEVICE_ID, config)
    }

    it('rewrites metadata.user_id to the JSON format', () => {
      const out = attribute(baseBody())
      const userId = JSON.parse((out.metadata as Record<string, string>).user_id)
      expect(userId.device_id).to.equal(DEVICE_ID)
      expect(userId.account_uuid).to.equal(ACCOUNT_UUID)
      expect(userId.session_id).to.match(/^[0-9a-f-]{36}$/)
    })

    it('prepends billing and identity system blocks', () => {
      const out = attribute(baseBody())
      const system = out.system as Array<Record<string, unknown>>
      expect(system).to.have.length(3)
      expect(system[2].text).to.equal('You are a helpful assistant.')
      expect(system[0].text).to.match(
        /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/
      )
      expect(system[1].text).to.equal("You are Claude Code, Anthropic's official CLI for Claude.")
      expect(system[1].cache_control).to.deep.equal({ type: 'ephemeral' })
    })

    it('keeps caller system blocks after the injected pair', () => {
      const body = { ...baseBody(), system: [{ type: 'text', text: 'caller prompt' }] }
      const system = attribute(body).system as Array<Record<string, unknown>>
      expect(system).to.have.length(3)
      expect(system[2].text).to.equal('caller prompt')
    })

    it('does not duplicate blocks when billing header is already present', () => {
      const body = {
        ...baseBody(),
        system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1; cc_entrypoint=cli;' }]
      }
      const system = attribute(body).system as Array<Record<string, unknown>>
      expect(system).to.have.length(1)
    })

    it('skips system injection when injectSystemBlocks is false', () => {
      const out = attribute(baseBody(), { injectSystemBlocks: false })
      expect(out.system).to.equal('You are a helpful assistant.')
    })

    it('signs cch over the injected body and is stable across runs', () => {
      const first = attribute(baseBody())
      const second = attribute(baseBody())
      const cchOf = (out: Record<string, unknown>) =>
        (out.system as Array<Record<string, string>>)[0].text.match(/cch=([0-9a-f]{5});/)?.[1]
      expect(cchOf(first)).to.match(/^[0-9a-f]{5}$/)
      // Session id falls back to the per-account cache, so both runs see the same body
      expect(cchOf(first)).to.equal(cchOf(second))
    })
  })
})

import crypto from 'crypto'
import { randomUUID } from 'crypto'
import type { IncomingHttpHeaders } from 'http'
import type { ProviderCredentials } from './oauth/types.js'
import { getAnthropicProfile } from './oauth/providers/anthropic.js'

/**
 * Claude subscription attribution: makes upstream api.anthropic.com traffic from
 * non-Claude-Code clients look like real Claude Code CLI traffic, mirroring what
 * CLIProxyAPI does (headers, anthropic-beta assembly, metadata.user_id, billing
 * system block). Confirmed Claude Code clients are passed through untouched.
 */

export interface ClaudeAttributionConfig {
  enabled?: boolean
  userAgent?: string
  anthropicBetaStrip?: string[]
  anthropicBetaAppend?: string[]
  injectSystemBlocks?: boolean
  signBillingCch?: boolean
  clientRequestId?: 'on' | 'off'
}

const CLAUDE_CODE_VERSION = '2.1.280'
const DEFAULT_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`

/**
 * Static CLI headers for the transform layer's SDK-based Anthropic clients.
 * These clients keep a shared connection, so per-request identity (session id,
 * x-client-request-id) and body attribution are only done on the /claude/* proxy.
 */
export const TRANSFORM_LAYER_CLI_HEADERS: Record<string, string> = {
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
  'user-agent': DEFAULT_USER_AGENT,
  'x-app': 'cli'
}
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const BILLING_FINGERPRINT_SALT = '59cf53e54c78'
const CCH_SEED = 0x4d659218e32a3268n

const STATIC_ATTRIBUTION_HEADERS: Record<string, string> = {
  'x-app': 'cli',
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
  'x-stainless-package-version': '0.112.1',
  'x-stainless-runtime-version': 'v26.3.0',
  'x-stainless-os': 'MacOS',
  'x-stainless-arch': 'arm64',
  'x-stainless-retry-count': '0',
  'x-stainless-runtime': 'node',
  'x-stainless-lang': 'js',
  'x-stainless-timeout': '600'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX64_RE = /^[0-9a-f]{64}$/
const LEGACY_USER_ID_RE = /^user_([^_]+)_account_(.*)_session_(.+)$/

// Per-account cached session id, used when neither the caller headers nor the
// body carry a Claude Code session identity.
const sessionCache = new Map<string, string>()

export interface ClaudeAttribution {
  confirmedClient: boolean
  headers: Record<string, string>
  sessionId: string
}

// --- Confirmed Claude Code client detection ----------------------------------
// Mirrors CLIProxyAPI's 4-signal check: all strong signals must be present.

function parseUserId(
  userId: unknown
): { deviceId?: string; accountUuid?: string; sessionId?: string } | null {
  if (typeof userId !== 'string') return null
  try {
    const parsed = JSON.parse(userId) as Record<string, unknown>
    if (typeof parsed.device_id !== 'string' || typeof parsed.session_id !== 'string') return null
    if (!HEX64_RE.test(parsed.device_id) || !UUID_RE.test(parsed.session_id)) return null
    if (parsed.account_uuid !== undefined && typeof parsed.account_uuid !== 'string') return null
    return {
      deviceId: parsed.device_id,
      accountUuid: parsed.account_uuid as string | undefined,
      sessionId: parsed.session_id
    }
  } catch {
    const match = userId.match(LEGACY_USER_ID_RE)
    if (!match) return null
    return { deviceId: match[1], accountUuid: match[2], sessionId: match[3] }
  }
}

export function isConfirmedClaudeCodeClient(
  headers: IncomingHttpHeaders,
  body: Record<string, unknown> | undefined
): boolean {
  if (headers['x-app'] !== 'cli') return false
  if (!/^claude-cli\/\d/i.test(String(headers['user-agent'] ?? ''))) return false
  const betas = String(headers['anthropic-beta'] ?? '')
  if (!betas.split(',').includes('claude-code-20250219')) return false
  const userId = parseUserId((body?.metadata as Record<string, unknown> | undefined)?.user_id)
  return userId !== null
}

// --- Session / device identity -------------------------------------------------

function resolveSessionId(
  headers: IncomingHttpHeaders,
  body: Record<string, unknown> | undefined,
  accountUuid: string
): string {
  const headerSession = headers['x-claude-code-session-id']
  if (typeof headerSession === 'string' && headerSession.length > 0) return headerSession

  const fromBody = parseUserId((body?.metadata as Record<string, unknown> | undefined)?.user_id)
  if (fromBody?.sessionId) return fromBody.sessionId

  let cached = sessionCache.get(accountUuid)
  if (!cached) {
    cached = randomUUID()
    sessionCache.set(accountUuid, cached)
  }
  return cached
}

/**
 * Get the per-credential stable device id (64 hex chars), generating and
 * persisting it via `persist` on first use.
 */
export function ensureDeviceId(credentials: ProviderCredentials, persist: () => void): string {
  if (!credentials.extra) credentials.extra = {}
  let deviceId = credentials.extra.deviceId as string | undefined
  if (!deviceId || !HEX64_RE.test(deviceId)) {
    deviceId = crypto.randomBytes(32).toString('hex')
    credentials.extra.deviceId = deviceId
    persist()
  }
  return deviceId
}

/** Build the JSON-string metadata.user_id format current Claude Code sends. */
export function buildJsonUserId(
  deviceId: string,
  accountUuid: string,
  sessionId: string,
  preserveFrom?: unknown
): string {
  const extras: Record<string, unknown> = {}
  if (typeof preserveFrom === 'string') {
    try {
      const parsed = JSON.parse(preserveFrom) as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed)) {
        if (key !== 'device_id' && key !== 'account_uuid' && key !== 'session_id') {
          extras[key] = value
        }
      }
    } catch {
      // legacy or opaque user_id: no extras to preserve
    }
  }
  return JSON.stringify({ device_id: deviceId, account_uuid: accountUuid, session_id: sessionId, ...extras })
}

// --- anthropic-beta assembly ---------------------------------------------------

function hasOneHourTtl(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasOneHourTtl)
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'cache_control' && value && typeof value === 'object') {
        const cc = value as Record<string, unknown>
        if (cc.ttl === '1h') return true
      } else if (hasOneHourTtl(value)) {
        return true
      }
    }
  }
  return false
}

/**
 * Derive the anthropic-beta header value in Claude Code's wire order.
 * Caller-supplied betas are appended after the derived set; config strip/append
 * is applied last.
 */
export function deriveAnthropicBeta(
  body: Record<string, unknown> | undefined,
  opts: { isOAuth: boolean; callerBeta?: string; config?: ClaudeAttributionConfig }
): string {
  const betas: string[] = ['claude-code-20250219']
  if (opts.isOAuth) betas.push('oauth-2025-04-20')

  const model = typeof body?.model === 'string' ? body.model : ''
  if (model.includes('[1m]')) betas.push('context-1m-2025-08-07')

  const thinking = body?.thinking as Record<string, unknown> | undefined
  if (thinking?.type === 'enabled') betas.push('interleaved-thinking-2025-05-14')

  if (body?.context_management) betas.push('context-management-2025-06-27')

  const outputConfig = body?.output_config as Record<string, unknown> | undefined
  if (outputConfig?.effort) betas.push('effort-2025-11-24')

  // Real Claude Code sends extended-cache-ttl with OAuth credentials unless the
  // body already pins a 1h cache TTL.
  if (opts.isOAuth && !hasOneHourTtl(body)) betas.push('extended-cache-ttl-2025-04-11')

  for (const callerBeta of (opts.callerBeta ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)) {
    if (!betas.includes(callerBeta)) betas.push(callerBeta)
  }

  const strip = new Set((opts.config?.anthropicBetaStrip ?? []).map((b) => b.trim()).filter(Boolean))
  const result = strip.size > 0 ? betas.filter((b) => !strip.has(b)) : betas
  for (const extra of opts.config?.anthropicBetaAppend ?? []) {
    const name = extra.trim()
    if (name && !result.includes(name)) result.push(name)
  }
  return result.join(',')
}

// --- xxHash64 (for the billing-header cch signature) ----------------------------

const P1 = 0x9e3779b185ebca87n
const P2 = 0xc2b2ae3d27d4eb4fn
const P3 = 0x165667b19e3779f9n
const P4 = 0x85ebca77c2b2ae63n
const P5 = 0x27d4eb2f165667c5n
const MASK = 0xffffffffffffffffn

const rotl = (x: bigint, n: bigint): bigint => ((x << n) | (x >> (64n - n))) & MASK
const read64 = (buf: Buffer, offset: number): bigint => buf.readBigUInt64LE(offset)
const read32 = (buf: Buffer, offset: number): bigint => BigInt(buf.readUInt32LE(offset))

function round64(acc: bigint, input: bigint): bigint {
  acc = (acc + input * P2) & MASK
  acc = rotl(acc, 31n)
  return (acc * P1) & MASK
}

function mergeRound(acc: bigint, input: bigint): bigint {
  const v = round64(0n, input)
  return ((((acc ^ v) * P1) & MASK) + P4) & MASK
}

export function xxhash64(buf: Buffer, seed: bigint): bigint {
  const len = buf.length
  let h: bigint
  let p = 0

  if (len >= 32) {
    let v1 = (seed + P1 + P2) & MASK
    let v2 = (seed + P2) & MASK
    let v3 = seed & MASK
    let v4 = (seed - P1) & MASK
    while (len - p >= 32) {
      v1 = round64(v1, read64(buf, p))
      v2 = round64(v2, read64(buf, p + 8))
      v3 = round64(v3, read64(buf, p + 16))
      v4 = round64(v4, read64(buf, p + 24))
      p += 32
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK
    h = mergeRound(h, v1)
    h = mergeRound(h, v2)
    h = mergeRound(h, v3)
    h = mergeRound(h, v4)
  } else {
    h = (seed + P5) & MASK
  }

  h = (h + BigInt(len)) & MASK

  while (len - p >= 8) {
    h = (rotl(h ^ round64(0n, read64(buf, p)), 27n) * P1 + P4) & MASK
    p += 8
  }
  if (len - p >= 4) {
    h = (rotl(h ^ ((read32(buf, p) * P1) & MASK), 23n) * P2 + P3) & MASK
    p += 4
  }
  while (p < len) {
    h = (rotl(h ^ ((BigInt(buf[p]) * P5) & MASK), 11n) * P1) & MASK
    p += 1
  }

  h ^= h >> 33n
  h = (h * P2) & MASK
  h ^= h >> 29n
  h = (h * P3) & MASK
  h ^= h >> 32n
  return h
}

// --- Billing header + identity system block -------------------------------------

function firstUserText(body: Record<string, unknown>): string {
  const messages = body.messages
  if (!Array.isArray(messages)) return ''
  for (const message of messages) {
    const msg = message as Record<string, unknown>
    if (msg.role !== 'user') continue
    const content = msg.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') return b.text
      }
    }
  }
  return ''
}

/** 3-char fingerprint Claude Code appends to cc_version, derived from the first user text. */
export function computeBillingFingerprint(text: string): string {
  const chars = [4, 7, 20]
    .map((i) => text[i])
    .filter((c) => c !== undefined)
    .join('')
  return crypto
    .createHash('sha256')
    .update(BILLING_FINGERPRINT_SALT + chars + CLAUDE_CODE_VERSION)
    .digest('hex')
    .slice(0, 3)
}

/**
 * cch signature: 5 lowercase hex digits of xxhash64 over the normalized request
 * body (model blanked, max_tokens/fallbacks/fallback_credit_token removed,
 * cch zeroed), matching the shape Claude Code signs.
 */
export function computeCch(bodyWithPlaceholder: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(bodyWithPlaceholder)) {
    if (key === 'max_tokens' || key === 'fallbacks' || key === 'fallback_credit_token') continue
    normalized[key] = key === 'model' ? '' : value
  }
  const hash = xxhash64(Buffer.from(JSON.stringify(normalized), 'utf-8'), CCH_SEED)
  return (hash & 0xfffffn).toString(16).padStart(5, '0')
}

function applyCch(body: Record<string, unknown>, systemBlocks: Array<Record<string, unknown>>): void {
  const cch = computeCch(body)
  const text = systemBlocks[0].text as string
  systemBlocks[0].text = text.replace('cch=00000;', `cch=${cch};`)
}

function injectBillingSystemBlocks(body: Record<string, unknown>, signCch: boolean): void {
  const existing = body.system
  const callerBlocks: Array<Record<string, unknown>> =
    typeof existing === 'string'
      ? [{ type: 'text', text: existing }]
      : Array.isArray(existing)
        ? (existing as Array<Record<string, unknown>>)
        : []

  // Already a Claude Code shaped system (real CLI client or a previous pass).
  if (
    callerBlocks.length > 0 &&
    typeof callerBlocks[0]?.text === 'string' &&
    callerBlocks[0].text.startsWith('x-anthropic-billing-header')
  ) {
    return
  }

  const fingerprint = computeBillingFingerprint(firstUserText(body))
  const billing = `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${fingerprint}; cc_entrypoint=cli; cch=00000;`
  const identity: Record<string, unknown> = { type: 'text', text: CLAUDE_CODE_IDENTITY }
  const injected: Array<Record<string, unknown>> = [
    { type: 'text', text: billing },
    { ...identity, cache_control: { type: 'ephemeral' } },
    ...callerBlocks
  ]

  if (signCch) {
    // Sign the body with the injected blocks in place (cch zeroed in the hash view).
    applyCch({ ...body, system: injected }, injected)
  }
  body.system = injected
}

// --- Top-level entry points -------------------------------------------------------

/**
 * Compute the full attribution state for a request: forced headers, session id,
 * and whether the caller is already a confirmed Claude Code client.
 */
export function computeClaudeAttribution(
  headers: IncomingHttpHeaders,
  body: Record<string, unknown> | undefined,
  credentials: ProviderCredentials,
  deviceId: string,
  config?: ClaudeAttributionConfig
): ClaudeAttribution {
  if (isConfirmedClaudeCodeClient(headers, body)) {
    return { confirmedClient: true, headers: {}, sessionId: '' }
  }

  const profile = getAnthropicProfile(credentials)
  const accountUuid = profile?.accountUuid ?? ''
  const sessionId = resolveSessionId(headers, body, accountUuid || 'default')

  const outHeaders: Record<string, string> = {
    ...STATIC_ATTRIBUTION_HEADERS,
    'user-agent': config?.userAgent?.trim() || DEFAULT_USER_AGENT,
    'x-claude-code-session-id': sessionId,
    'anthropic-beta': deriveAnthropicBeta(body, {
      isOAuth: true,
      callerBeta: Array.isArray(headers['anthropic-beta'])
        ? headers['anthropic-beta'].join(',')
        : (headers['anthropic-beta'] as string | undefined),
      config
    })
  }
  if ((config?.clientRequestId ?? 'on') === 'on') {
    outHeaders['x-client-request-id'] = randomUUID()
  }

  return { confirmedClient: false, headers: outHeaders, sessionId }
}

/**
 * Apply body-level attribution (metadata.user_id rewrite + billing/identity
 * system blocks) to a request body. Returns a new body; mutates nothing shared.
 */
export function applyClaudeAttributionToBody(
  body: Record<string, unknown>,
  attribution: ClaudeAttribution,
  credentials: ProviderCredentials,
  deviceId: string,
  config?: ClaudeAttributionConfig
): Record<string, unknown> {
  if (attribution.confirmedClient) return body
  const profile = getAnthropicProfile(credentials)
  if (!profile) return body

  const out: Record<string, unknown> = {
    ...body,
    metadata: {
      ...(body.metadata as Record<string, unknown> | undefined),
      user_id: buildJsonUserId(
        deviceId,
        profile.accountUuid,
        attribution.sessionId,
        (body.metadata as Record<string, unknown> | undefined)?.user_id
      )
    }
  }
  if (config?.injectSystemBlocks !== false) {
    injectBillingSystemBlocks(out, config?.signBillingCch !== false)
  }
  return out
}

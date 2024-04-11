# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A multi-provider AI proxy that provides unified access to Claude, Gemini, and OpenAI models. Features a **Transform Layer** that converts between API formats (OpenAI, Anthropic, Gemini) with provider-based routing via `X-LLM-Provider` header. Also provides direct reverse proxies to Anthropic/OpenAI/Google/Vertex AI APIs with multi-provider OAuth authentication. Built with FeathersJS and Express.

## Development Commands

All commands run from the `app/` directory:

```bash
cd app
npm install          # Install dependencies
npm run dev          # Development server with hot reload (nodemon + ts-node)
npm run compile      # Compile TypeScript to lib/
npm start            # Production server (runs compiled JS from lib/)
npm test             # Run tests with Mocha (48 tests)
npm run prettier     # Format TypeScript files
```

## Architecture

```
app/
├── src/
│   ├── index.ts                    # Entry point - creates app, startup banner
│   ├── app.ts                      # FeathersJS/Express app configuration
│   ├── declarations.ts             # TypeScript type declarations
│   ├── logger.ts                   # Winston logger with timestamps
│   ├── hooks/
│   │   └── log-error.ts            # Error logging hook
│   ├── shared/
│   │   ├── auth.ts                 # Bearer token authentication (proxy users)
│   │   ├── reverse-proxy.ts        # Generic reverse proxy factory (used by claude/openai/google proxies)
│   │   ├── errors.ts               # Typed error handling utilities
│   │   ├── sse-utils.ts            # SSE header setup utility
│   │   ├── client-cache.ts         # Generic client cache factory
│   │   ├── connection-pool.ts      # HTTP connection pooling
│   │   ├── constants.ts            # Shared constants (max tokens)
│   │   └── oauth/                  # Multi-provider OAuth system
│   │       ├── types.ts            # OAuthProviderConfig, ProviderCredentials, LLMProvider
│   │       ├── token-manager.ts    # TokenManager - token resolution, refresh, flow state
│   │       ├── credential-store.ts # Persisted credential storage
│   │       ├── pkce.ts             # PKCE code verifier/challenge generation
│   │       └── providers/
│   │           ├── anthropic.ts    # Anthropic OAuth provider config
│   │           ├── openai.ts       # OpenAI OAuth provider config
│   │           └── google.ts       # Google OAuth provider config
│   ├── anthropic/                  # Transform Layer: Anthropic Messages API
│   │   ├── index.ts                # Registers POST /v1/messages route
│   │   ├── messages.ts             # Handler: multi-provider routing via X-LLM-Provider
│   │   └── translators/
│   │       ├── types.ts            # MessagesTranslator interface
│   │       ├── openai-translator.ts  # Anthropic <-> OpenAI format translation
│   │       └── gemini-translator.ts  # Anthropic <-> Gemini format translation
│   ├── openai/                     # Transform Layer: OpenAI-compatible API
│   │   ├── index.ts                # Registers /v1/chat/completions route
│   │   ├── chat-completions.ts     # Handler: multi-provider routing via X-LLM-Provider
│   │   ├── types.ts                # OpenAI API type definitions
│   │   ├── utils.ts                # ID generation, finish reason mapping
│   │   └── translators/
│   │       ├── types.ts            # Translator interface, LLMProvider type
│   │       ├── claude-translator.ts  # OpenAI <-> Claude format (Vertex AI + direct API)
│   │       ├── gemini-translator.ts  # OpenAI <-> Gemini format (Vertex AI + direct API)
│   │       └── openai-translator.ts  # OpenAI passthrough to api.openai.com
│   ├── claude-proxy/               # Reverse proxy to api.anthropic.com
│   │   ├── index.ts                # Registers /claude/* route
│   │   ├── proxy.ts                # Claude-specific proxy handler
│   │   └── messages.ts             # Message handling utilities
│   ├── openai-proxy/               # Reverse proxy to api.openai.com
│   │   └── index.ts                # Registers /openai/* route
│   ├── google-proxy/               # Reverse proxy to generativelanguage.googleapis.com
│   │   └── index.ts                # Registers /google/* route
│   ├── vertexai-proxy/             # Reverse proxy to {location}-aiplatform.googleapis.com
│   │   └── index.ts                # Registers /vertex-ai/* route (service account auth)
│   ├── chatgpt-proxy/              # Reverse proxy to chatgpt.com/backend-api
│   │   └── index.ts                # Registers /chatgpt/* route (OpenAI OAuth, adds chatgpt-account-id)
│   └── oauth/                      # OAuth UI and callback routes
│       ├── index.ts                # Registers /oauth/* routes
│       ├── callback.ts             # OAuth callback handler (all providers)
│       └── dashboard.ts            # OAuth status dashboard
├── test/
│   ├── setup.ts                    # Test configuration
│   ├── fixtures/mock-data.ts       # Test fixtures
│   ├── unit/                       # Unit tests
│   └── integration/                # Integration tests
├── config/
│   ├── default.json                # App config (port, users, vertex project/location)
│   └── vertex-ai.json              # Google service account credentials (not in repo)
└── lib/                            # Compiled JavaScript output
```

## Key Implementation Details

### API Endpoints

#### Transform Layer (format conversion with multi-provider routing)

Both transform layer endpoints require the `X-LLM-Provider` header to specify the backend provider.
Valid values: `openai`, `claude`, `google`, `vertex-ai`.

1. **OpenAI-Compatible Translation**: `POST /v1/chat/completions`
   - Accepts OpenAI chat completion format
   - `X-LLM-Provider: openai` — passthrough to api.openai.com
   - `X-LLM-Provider: claude` — translates to Anthropic format, sends to api.anthropic.com
   - `X-LLM-Provider: google` — translates to Gemini format, sends to generativelanguage.googleapis.com
   - `X-LLM-Provider: vertex-ai` — routes by model prefix (claude-*/gemini-*) to Vertex AI
   - Supports streaming and function/tool calling

2. **Anthropic Messages API**: `POST /v1/messages`
   - Accepts native Anthropic Messages API format
   - `X-LLM-Provider: claude` — passthrough to api.anthropic.com via Anthropic SDK
   - `X-LLM-Provider: vertex-ai` — passthrough to Vertex AI via AnthropicVertex SDK
   - `X-LLM-Provider: openai` — translates to OpenAI format, sends to api.openai.com
   - `X-LLM-Provider: google` — translates to Gemini format, sends via GoogleGenAI SDK
   - Supports streaming (SSE with `event:` prefixes) and non-streaming

#### Direct Proxies (passthrough, no format conversion)

3. **Claude Direct Proxy**: `/claude/*` -> `api.anthropic.com`
   - Reverse proxy using OAuth or `ANTHROPIC_API_KEY`

4. **OpenAI Direct Proxy**: `/openai/*` -> `api.openai.com`
   - Reverse proxy using OAuth or `OPENAI_API_KEY`

5. **Google Direct Proxy**: `/google/*` -> `generativelanguage.googleapis.com`
   - Reverse proxy using OAuth or `GOOGLE_API_KEY`

6. **Vertex AI Direct Proxy**: `/vertex-ai/*` -> `{location}-aiplatform.googleapis.com`
   - Reverse proxy using service account auth (`GOOGLE_APPLICATION_CREDENTIALS`)
   - Dynamically resolves hostname from the location in the URL path

7. **ChatGPT Direct Proxy**: `/chatgpt/*` -> `chatgpt.com/backend-api`
   - Reverse proxy using OpenAI OAuth (reuses `openai` provider credentials)
   - Automatically injects `chatgpt-account-id` header from the JWT-extracted account ID

8. **OAuth Dashboard & Routes**: `/oauth`
   - `GET /oauth` — Status dashboard showing all provider auth states
   - `GET /oauth/login/:provider` — Initiate OAuth flow for a provider
   - `GET /oauth/callback/:provider` — OAuth callback handler
   - `GET /oauth/token/:provider` — Retrieve current token (requires Bearer auth)
   - `POST /oauth/logout/:provider` — Delete provider credentials (requires Bearer auth)

### Authentication

Two layers of authentication:

1. **Client-to-Proxy**: Bearer token in `Authorization` header, validated against `users[].secret` in `config/default.json`. Required for all proxy endpoints.

2. **Proxy-to-Upstream**: Depends on the provider:
   - **Direct proxies (claude/openai/google/chatgpt)**: OAuth system or environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`)
   - **Vertex AI proxy**: Service account via `GOOGLE_APPLICATION_CREDENTIALS`
   - **Transform layer**: Uses `tokenManager` to resolve tokens per provider (env var checked first, then OAuth)

### Transform Layer Translators

The transform layer uses a Translator pattern for format conversion:

- **OpenAI endpoint translators** (`src/openai/translators/`):
  - `claude-translator.ts` — OpenAI ↔ Anthropic format (supports both direct API and Vertex AI)
  - `gemini-translator.ts` — OpenAI ↔ Gemini format (supports both direct API and Vertex AI)
  - `openai-translator.ts` — passthrough to api.openai.com

- **Messages endpoint translators** (`src/anthropic/translators/`):
  - `openai-translator.ts` — Anthropic ↔ OpenAI format
  - `gemini-translator.ts` — Anthropic ↔ Gemini format

### Other Details
- **Logging**: Request/response logging with timestamps, request IDs, and duration
- **Error Handling**: Typed error utilities in `shared/errors.ts` for safe error extraction
- **Reverse Proxy**: Generic `createReverseProxy()` factory handles header stripping, auth injection, streaming, and auto-retry on 401/403 with token refresh

## Configuration

`config/default.json`:
- `users`: Array of `{username, secret}` for authentication
- `vertex.project`: Google Cloud Project ID (used by vertex-ai provider in transform layer)
- `vertex.location`: Vertex AI region (e.g., `global`, `us-central1`)

## Environment Variables

- `NODE_ENV`: Set to `development` for detailed error messages in responses
- `LOG_LEVEL`: Logging level (`debug`, `info`, `warn`, `error`)
- `GOOGLE_APPLICATION_CREDENTIALS`: Path to service account JSON (for Vertex AI)
- `ANTHROPIC_API_KEY`: Anthropic API key (bypasses OAuth for Claude proxy and transform layer)
- `OPENAI_API_KEY`: OpenAI API key (bypasses OAuth for OpenAI proxy and transform layer)
- `GOOGLE_API_KEY`: Google API key (bypasses OAuth for Google proxy and transform layer)

## Docker

```bash
# Using docker-compose (recommended)
docker-compose up -d

# View logs
docker-compose logs -f

# Rebuild after code changes
docker-compose up --build -d
```

## Development Guidelines

- **Type Safety**: Avoid `any` casts. Use `unknown` with type guards or `getErrorDetails()` for errors.
- **Error Handling**: Use utilities from `shared/errors.ts` (`getErrorDetails`, `isNotFoundError`)
- **Constants**: Use constants from `shared/constants.ts` instead of magic numbers
- **SSE Headers**: Use `setupSSEHeaders()` from `shared/sse-utils.ts` for streaming responses
- **Client Caching**: Use `createClientCache()` from `shared/client-cache.ts` for SDK clients
- **Reverse Proxies**: New direct proxies should use `createReverseProxy()` from `shared/reverse-proxy.ts`
- **OAuth Providers**: New providers implement `OAuthProviderConfig` in `shared/oauth/providers/` and register in `token-manager.ts`
- **Transform Layer**: New translators implement `Translator` (for OpenAI endpoint) or `MessagesTranslator` (for Messages endpoint) interfaces
- **Testing**: Run `npm test` before committing. Maintain test coverage.

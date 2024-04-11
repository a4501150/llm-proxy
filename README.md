# Vertex AI Proxy

A passthrough proxy for Google Cloud Vertex AI, designed for Claude Code to access Claude and Gemini models on Vertex AI from remote machines without requiring local GCP credentials.

## Features

- **Simplified Authentication**: Replaces complex Vertex AI authentication with permanent user secrets
- **Claude Code Support**: Works as a Vertex AI passthrough proxy for Claude Code
- **Multi-Model Support**: Supports Claude models (via Anthropic Vertex SDK) and Gemini models (via Google GenAI SDK)
- **Streaming Support**: Full SSE streaming for both Claude and Gemini models
- **Request Logging**: Detailed logging with timestamps, request IDs, and duration tracking
- **Connection Pooling**: Efficient HTTP connection reuse for better performance

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/a4501150/vertex-api-proxy.git
cd vertex-api-proxy/app
npm install
```

### 2. Configure

Create `config/default.json`:

```json
{
  "host": "0.0.0.0",
  "port": 3030,
  "users": [
    { "username": "user1", "secret": "your-secret-token" }
  ],
  "vertex": {
    "project": "your-gcp-project-id",
    "location": "us-east5"
  }
}
```

### 3. Set Up Google Cloud Credentials

```bash
# Option 1: Application Default Credentials
gcloud auth application-default login

# Option 2: Service Account
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

### 4. Run

```bash
# Development
npm run dev

# Production
npm run compile && npm start
```

## Docker Deployment (Recommended)

```yaml
# docker-compose.yml
services:
  vertex-ai-proxy:
    build: .
    ports:
      - "3030:3030"
    volumes:
      - ./config:/usr/src/app/config
      - ~/.config/gcloud/application_default_credentials.json:/gcloud/adc.json:ro
    environment:
      - GOOGLE_APPLICATION_CREDENTIALS=/gcloud/adc.json
      - NODE_ENV=production
      - LOG_LEVEL=info
    restart: unless-stopped
```

```bash
docker-compose up -d
docker-compose logs -f
```

## Claude Code Configuration

Add to `~/.claude/settings.json` on the client machine:

```json
{
  "env": {
    "CLAUDE_CODE_USE_VERTEX": "1",
    "ANTHROPIC_VERTEX_BASE_URL": "http://PROXY_IP:3030/v1",
    "ANTHROPIC_VERTEX_PROJECT_ID": "your-gcp-project-id",
    "ANTHROPIC_AUTH_TOKEN": "your-proxy-secret",
    "CLOUD_ML_REGION": "us-east5",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH": "1"
  },
  "model": "claude-sonnet-4-20250514"
}
```

## API Endpoint

```
POST /v1/projects/{project}/locations/{location}/publishers/{publisher}/models/{model}
Authorization: Bearer <your-secret-token>
```

### Supported Models

| Provider | Model Examples | Streaming Method |
|----------|---------------|------------------|
| Claude | `claude-sonnet-4-20250514`, `claude-opus-4-20250514` | `:streamRawPredict` |
| Gemini | `gemini-2.0-flash`, `gemini-1.5-pro` | `:streamGenerateContent` |

## Configuration Options

### config/default.json

| Field | Description |
|-------|-------------|
| `host` | Server bind address |
| `port` | Server port |
| `users` | Array of `{username, secret}` for authentication |
| `vertex.project` | Google Cloud Project ID |
| `vertex.location` | Vertex AI region (e.g., `us-east5`, `us-central1`) |
| `vertex.useClientParams` | Use URL params instead of config values |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | `development` for detailed errors, `production` for minimal |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account JSON |

## Development

```bash
cd app
npm install          # Install dependencies
npm run dev          # Development server with hot reload
npm test             # Run tests (82 tests)
npm run compile      # Compile TypeScript
npm run prettier     # Format code
```

## Security Considerations

- Use HTTPS/TLS encryption for production deployments
- Keep user secrets secure and rotate them periodically
- Consider implementing rate limiting
- Restrict network access to the proxy server

## License

MIT License

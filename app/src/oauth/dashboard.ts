import type express from 'express'
import { tokenManager } from '../shared/oauth/token-manager.js'
import type { ProviderStatus } from '../shared/oauth/types.js'

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderProviderCard(status: ProviderStatus): string {
  const indicator = status.authenticated
    ? '<span class="status-dot authenticated"></span>'
    : '<span class="status-dot unauthenticated"></span>'

  const methodLabel =
    status.method === 'env' ? 'Environment Variable' : status.method === 'oauth' ? 'OAuth' : 'Not Configured'

  let details = ''

  if (status.method === 'oauth' && status.expiresAt) {
    const expiry = new Date(status.expiresAt)
    details += `<p class="detail"><span class="label">Expires:</span> ${escapeHtml(expiry.toLocaleString())}</p>`
  }

  if (status.displayInfo) {
    for (const [key, value] of Object.entries(status.displayInfo)) {
      details += `<p class="detail"><span class="label">${escapeHtml(key)}:</span> ${escapeHtml(value)}</p>`
    }
  }

  let action = ''
  if (!status.authenticated) {
    action = `<a class="btn login-btn" href="/oauth/login/${escapeHtml(status.id)}">Login</a>`

    // Check if this provider uses a fixed redirect URI (needs manual paste fallback)
    const provider = tokenManager.getProvider(status.id)
    if (provider.fixedRedirectUri) {
      action += `
        <div class="paste-section">
          <p class="paste-hint">Remote server? After login, paste the redirect URL here:</p>
          <form data-paste-form data-provider="${escapeHtml(status.id)}" class="paste-form">
            <input type="text" name="redirect_url" placeholder="http://localhost:.../callback?code=...&state=..." class="paste-input" />
            <button type="submit" class="btn submit-btn">Submit</button>
          </form>
          <p class="paste-status" data-paste-status></p>
        </div>`
    }
  } else if (status.method === 'oauth') {
    action = `<a class="btn reauth-btn" href="/oauth/login/${escapeHtml(status.id)}">Re-authenticate</a>`

    const provider = tokenManager.getProvider(status.id)
    if (provider.fixedRedirectUri) {
      action += `
        <div class="paste-section">
          <p class="paste-hint">Remote server? After login, paste the redirect URL here:</p>
          <form data-paste-form data-provider="${escapeHtml(status.id)}" class="paste-form">
            <input type="text" name="redirect_url" placeholder="http://localhost:.../callback?code=...&state=..." class="paste-input" />
            <button type="submit" class="btn submit-btn">Submit</button>
          </form>
          <p class="paste-status" data-paste-status></p>
        </div>`
    }
  }

  return `
    <div class="card">
      <div class="card-header">
        ${indicator}
        <h2>${escapeHtml(status.name)}</h2>
      </div>
      <p class="method">${escapeHtml(methodLabel)}</p>
      ${details}
      ${action}
    </div>`
}

function renderPage(statuses: ProviderStatus[]): string {
  const cards = statuses.map(renderProviderCard).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vertex AI Proxy - OAuth Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 2rem;
    }
    h1 {
      text-align: center;
      margin-bottom: 2rem;
      font-size: 1.5rem;
      font-weight: 600;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 1.5rem;
      max-width: 960px;
      margin: 0 auto;
    }
    .card {
      background: #16213e;
      border-radius: 8px;
      padding: 1.5rem;
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }
    .card-header h2 {
      font-size: 1.1rem;
      font-weight: 600;
    }
    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .status-dot.authenticated { background: #4caf50; }
    .status-dot.unauthenticated { background: #f44336; }
    .method {
      font-size: 0.85rem;
      color: #9e9e9e;
      margin-bottom: 0.5rem;
    }
    .detail {
      font-size: 0.85rem;
      margin-bottom: 0.25rem;
    }
    .detail .label {
      color: #9e9e9e;
    }
    .btn {
      display: inline-block;
      margin-top: 0.75rem;
      padding: 0.5rem 1.25rem;
      border-radius: 4px;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 500;
    }
    .login-btn {
      background: #0d47a1;
      color: #e0e0e0;
    }
    .login-btn:hover {
      background: #1565c0;
    }
    .reauth-btn {
      background: #4a4a00;
      color: #e0e0e0;
    }
    .reauth-btn:hover {
      background: #6a6a00;
    }
    .paste-section {
      margin-top: 1rem;
      padding-top: 0.75rem;
      border-top: 1px solid #2a2a4a;
    }
    .paste-hint {
      font-size: 0.8rem;
      color: #9e9e9e;
      margin-bottom: 0.5rem;
    }
    .paste-form {
      display: flex;
      gap: 0.5rem;
    }
    .paste-input {
      flex: 1;
      padding: 0.4rem 0.6rem;
      border: 1px solid #2a2a4a;
      border-radius: 4px;
      background: #1a1a2e;
      color: #e0e0e0;
      font-size: 0.8rem;
      font-family: monospace;
    }
    .paste-input:focus {
      outline: none;
      border-color: #0d47a1;
    }
    .submit-btn {
      background: #2e7d32;
      color: #e0e0e0;
      border: none;
      cursor: pointer;
    }
    .submit-btn:hover {
      background: #388e3c;
    }
    .submit-btn[disabled] {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .paste-status {
      margin-top: 0.5rem;
      font-size: 0.8rem;
      min-height: 1em;
      word-break: break-word;
    }
    .paste-status.success { color: #4ecca3; }
    .paste-status.error { color: #e57373; }
    .paste-status.pending { color: #9e9e9e; }
    .paste-status .raw {
      display: block;
      margin-top: 0.4rem;
      padding: 0.4rem 0.6rem;
      background: #0e1726;
      border: 1px solid #2a2a4a;
      border-radius: 4px;
      color: #b0b0b0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <h1>Vertex AI Proxy - OAuth Dashboard</h1>
  <div class="grid">
    ${cards}
  </div>
  <script>
    (function () {
      let submitting = false;

      document.querySelectorAll('form[data-paste-form]').forEach(function (form) {
        form.addEventListener('submit', async function (e) {
          e.preventDefault();
          if (submitting) return;

          const provider = form.dataset.provider;
          const input = form.querySelector('input[name="redirect_url"]');
          const button = form.querySelector('button[type="submit"]');
          const statusEl = form.parentElement.querySelector('[data-paste-status]');

          const value = (input.value || '').trim();
          if (!value) {
            statusEl.textContent = 'Paste a URL first.';
            statusEl.className = 'paste-status error';
            return;
          }

          submitting = true;
          button.disabled = true;
          input.disabled = true;
          statusEl.textContent = 'Exchanging code...';
          statusEl.className = 'paste-status pending';

          try {
            const res = await fetch('/oauth/complete/' + encodeURIComponent(provider), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ redirect_url: value })
            });
            const data = await res.json().catch(function () { return {}; });
            if (!res.ok) {
              const e = new Error(data.error || ('HTTP ' + res.status));
              if (data.raw) e.raw = data.raw;
              throw e;
            }
            statusEl.textContent = 'Authenticated! Refreshing...';
            statusEl.className = 'paste-status success';
            setTimeout(function () { window.location.reload(); }, 600);
          } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            statusEl.className = 'paste-status error';
            statusEl.textContent = '';
            const main = document.createElement('div');
            main.textContent = msg;
            statusEl.appendChild(main);
            if (err && err.raw && err.raw !== msg) {
              const raw = document.createElement('code');
              raw.className = 'raw';
              raw.textContent = err.raw;
              statusEl.appendChild(raw);
            }
            button.disabled = false;
            input.disabled = false;
            submitting = false;
          }
        });
      });

      // Periodic refresh, paused during submit
      setInterval(function () {
        if (!submitting) window.location.reload();
      }, 30000);
    })();
  </script>
</body>
</html>`
}

export async function dashboardHandler(req: express.Request, res: express.Response): Promise<void> {
  const app = req.app
  const port = app.get('port')
  const host = app.get('host')
  const publicUrl =
    (app as any).get('publicUrl') || `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`

  const statuses = tokenManager.getAllStatuses(publicUrl)
  const html = renderPage(statuses)

  res.type('html').send(html)
}

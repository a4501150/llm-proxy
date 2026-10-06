import type { PublicState } from './state.js'
import type { RuntimeOverrides } from '../shared/runtime-config.js'

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const ROUTES: { path: string; upstream: string }[] = [
  { path: '/claude/*', upstream: 'api.anthropic.com' },
  { path: '/openai/*', upstream: 'api.openai.com' },
  { path: '/google/*', upstream: 'generativelanguage.googleapis.com' },
  { path: '/vertex-ai/*', upstream: '{location}-aiplatform.googleapis.com' },
  { path: '/taskforce/glm-5-3[-flash]/*', upstream: 'hendrix-genai.spotify.net' },
  { path: '/v1/messages', upstream: 'translate to Vertex / OpenAI / Gemini' },
  { path: '/v1/chat/completions', upstream: 'translate to Vertex / Gemini' }
]

function renderRoutes(): string {
  return ROUTES.map(
    (r) =>
      `<tr><td class="route-path">${escapeHtml(r.path)}</td><td class="route-arrow">→</td><td class="route-up">${escapeHtml(r.upstream)}</td></tr>`
  ).join('\n')
}

function renderUserRows(state: PublicState): string {
  if (state.users.length === 0) {
    return '<tr><td colspan="4" class="empty">No users yet — add one below.</td></tr>'
  }
  return state.users
    .map(
      (u) => `
      <tr data-user-row>
        <td class="u-name">${escapeHtml(u.username)}</td>
        <td class="u-masked">${escapeHtml(u.maskedSecret)}</td>
        <td><input type="password" class="field u-secret" data-username="${escapeHtml(u.username)}" placeholder="unchanged" autocomplete="off" /></td>
        <td><button type="button" class="btn danger sm user-delete">Remove</button></td>
      </tr>`
    )
    .join('\n')
}

function renderLogging(state: PublicState): string {
  const levels = ['error', 'warn', 'info', 'debug']
  const options = levels
    .map((l) => `<option value="${l}"${l === state.logging.level ? ' selected' : ''}>${l}</option>`)
    .join('')
  return `
    <section class="panel">
      <h2>Logging</h2>
      <p class="note">Body capture writes complete request and response payloads — prompts and tokens included — to the debug stream. Settings survive restarts.</p>
      <div class="field-row">
        <label class="lbl" for="log-level">Log level</label>
        <select id="log-level" class="field">${options}</select>
      </div>
      <label class="check"><input type="checkbox" id="log-bodies"${state.logging.logBodies ? ' checked' : ''} /> <span>Capture request &amp; response bodies</span></label>
      <button type="button" class="btn primary" id="save-logging">Save logging</button>
    </section>`
}

function renderVertex(state: PublicState): string {
  return `
    <section class="panel">
      <h2>Vertex AI</h2>
      <p class="note">Applies to the next request. Requests may override these when client params are allowed.</p>
      <div class="field-row">
        <label class="lbl" for="vertex-project">Project</label>
        <input id="vertex-project" class="field" value="${escapeHtml(state.vertex.project)}" />
      </div>
      <div class="field-row">
        <label class="lbl" for="vertex-location">Location</label>
        <input id="vertex-location" class="field" value="${escapeHtml(state.vertex.location)}" />
      </div>
      <label class="check"><input type="checkbox" id="vertex-client-params"${state.vertex.useClientParams ? ' checked' : ''} /> <span>Allow client-provided project/location</span></label>
      <button type="button" class="btn primary" id="save-vertex">Save vertex</button>
    </section>`
}

function renderUsers(state: PublicState): string {
  return `
    <section class="panel wide">
      <h2>Proxy users<span class="hint-inline">secrets stay masked; a blank secret keeps the current one</span></h2>
      <table class="users">
        <colgroup><col class="c-name"><col class="c-masked"><col><col class="c-act"></colgroup>
        <thead><tr><th>Username</th><th>Secret</th><th>New secret</th><th></th></tr></thead>
        <tbody>
          ${renderUserRows(state)}
        </tbody>
      </table>
      <div class="field-row add-user">
        <input id="new-user-name" class="field" placeholder="username" />
        <input id="new-user-secret" class="field" placeholder="secret" autocomplete="off" />
        <button type="button" class="btn" id="add-user">Add user</button>
        <button type="button" class="btn primary" id="save-users">Save users</button>
      </div>
    </section>`
}

export function renderHomePage(state: PublicState, overrides: RuntimeOverrides): string {
  const persisted = Object.keys(overrides)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LLM Proxy</title>
  <style>
    :root {
      --ink: #10161d;
      --panel: #161d27;
      --line: #2a333f;
      --row-line: #1d2530;
      --text: #dfe6ee;
      --muted: #8b96a5;
      --amber: #e8a33d;
      --mint: #57d9a3;
      --red: #e06c75;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--sans);
      background: var(--ink);
      color: var(--text);
      min-height: 100vh;
      padding: 2.5rem 1.5rem;
    }
    .wrap { max-width: 1080px; margin: 0 auto; }

    header {
      display: flex;
      align-items: baseline;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 0.9rem;
    }
    h1 {
      font-family: var(--mono);
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    h1 .ok-dot {
      display: inline-block;
      width: 9px; height: 9px;
      border-radius: 50%;
      background: var(--mint);
      margin-right: 10px;
      vertical-align: 1px;
    }
    header a {
      margin-left: auto;
      color: var(--amber);
      font-size: 0.85rem;
      text-decoration: none;
      border-bottom: 1px solid transparent;
    }
    header a:hover, header a:focus-visible { border-bottom-color: var(--amber); }

    /* the routing table is what this proxy is; the page opens with it */
    .routes {
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--panel);
      margin-bottom: 1.5rem;
      overflow-x: auto;
    }
    .routes table { border-collapse: collapse; width: 100%; font-family: var(--mono); font-size: 0.78rem; }
    .routes th {
      text-align: left; font-family: var(--sans); font-size: 0.7rem; font-weight: 500;
      color: var(--muted); padding: 0.45rem 0.9rem; border-bottom: 1px solid var(--line);
    }
    .routes td { padding: 0.3rem 0.9rem; border-bottom: 1px solid var(--row-line); }
    .routes tr:last-child td { border-bottom: none; }
    .route-path { color: var(--text); white-space: nowrap; }
    .route-arrow { color: var(--amber); width: 2em; }
    .route-up { color: var(--muted); }

    .toolbar {
      display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap;
      margin-bottom: 1.5rem;
    }
    .toolbar .note { margin-bottom: 0; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 1.4rem;
    }
    .panel.wide { grid-column: 1 / -1; }
    .panel h2 { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.4rem; }
    .hint-inline { font-weight: 400; font-size: 0.75rem; color: var(--muted); margin-left: 0.6rem; }
    .note { color: var(--muted); font-size: 0.78rem; line-height: 1.55; margin-bottom: 1rem; max-width: 70ch; }

    .field-row { display: flex; gap: 0.6rem; align-items: center; margin-bottom: 0.7rem; flex-wrap: wrap; }
    .lbl { width: 6.5rem; font-size: 0.82rem; color: var(--muted); }
    .field {
      padding: 0.42rem 0.6rem;
      border: 1px solid var(--line);
      border-radius: 3px;
      background: var(--ink);
      color: var(--text);
      font-size: 0.83rem;
      font-family: var(--mono);
    }
    .field:focus-visible { outline: 2px solid var(--amber); outline-offset: 1px; border-color: transparent; }
    .check {
      display: flex; gap: 0.5rem; align-items: center;
      font-size: 0.83rem; color: var(--text);
      margin: 0.2rem 0 1rem; cursor: pointer;
    }
    .check input { accent-color: var(--amber); width: 14px; height: 14px; }

    .btn {
      padding: 0.45rem 1rem;
      border: 1px solid var(--line);
      border-radius: 3px;
      font-size: 0.82rem;
      font-weight: 500;
      font-family: var(--sans);
      cursor: pointer;
      background: transparent;
      color: var(--text);
    }
    .btn:hover { border-color: var(--muted); }
    .btn:focus-visible { outline: 2px solid var(--amber); outline-offset: 1px; }
    .btn.primary { background: var(--amber); border-color: var(--amber); color: #1a1206; }
    .btn.primary:hover { background: #f0b355; }
    .btn.danger { color: var(--red); border-color: #4a2b30; }
    .btn.danger:hover { border-color: var(--red); }
    .btn.sm { padding: 0.28rem 0.7rem; font-size: 0.76rem; }

    table.users { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 0.9rem; }
    table.users th { text-align: left; font-size: 0.72rem; color: var(--muted); font-weight: 500; padding: 0.3rem 0.45rem; border-bottom: 1px solid var(--line); }
    table.users td { padding: 0.4rem 0.45rem; font-size: 0.85rem; border-bottom: 1px solid var(--row-line); vertical-align: middle; }
    table.users tbody tr:last-child td { border-bottom: none; }
    table.users .u-name, table.users .u-masked { font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    table.users .u-secret { width: 100%; }
    table.users .empty { color: var(--muted); font-style: italic; }
    col.c-name { width: 18%; }
    col.c-masked { width: 15%; }
    col.c-act { width: 13%; }
    .add-user .field { flex: 1; min-width: 140px; }
    .add-user { margin-bottom: 0; }

    footer { margin-top: 1.75rem; text-align: center; color: #5b6572; font-size: 0.72rem; font-family: var(--mono); }

    #status {
      position: fixed;
      bottom: 1.25rem; right: 1.25rem;
      padding: 0.55rem 1.1rem;
      border-radius: 3px;
      background: var(--panel);
      font-size: 0.83rem;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 160ms ease, transform 160ms ease;
      pointer-events: none;
    }
    #status.ok { opacity: 1; transform: none; border: 1px solid var(--mint); color: var(--mint); }
    #status.err { opacity: 1; transform: none; border: 1px solid var(--red); color: var(--red); }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1><span class="ok-dot" aria-hidden="true"></span>LLM&nbsp;Proxy</h1>
      <a href="/oauth">OAuth dashboard</a>
    </header>

    <div class="routes" aria-label="request routing">
      <table>
        <thead><tr><th>Route</th><th></th><th>Upstream</th></tr></thead>
        <tbody>
          ${renderRoutes()}
        </tbody>
      </table>
    </div>

    <div class="toolbar">
      <input id="admin-secret" type="password" class="field" placeholder="proxy secret" autocomplete="off" style="width: 260px" />
      <span class="note">Needed to save anything below. Kept in this browser tab only, sent as a bearer token.</span>
    </div>

    <div class="grid">
      ${renderLogging(state)}
      ${renderVertex(state)}
      ${renderUsers(state)}
    </div>

    <footer>${persisted.length > 0 ? `saved overrides: ${persisted.map(escapeHtml).join(', ')}` : 'no saved overrides yet'}</footer>
  </div>
  <div id="status" role="status" aria-live="polite"></div>

  <script>
    (function () {
      const secretInput = document.getElementById('admin-secret');
      secretInput.value = sessionStorage.getItem('proxySecret') || '';
      secretInput.addEventListener('change', function () {
        sessionStorage.setItem('proxySecret', secretInput.value);
      });

      const statusEl = document.getElementById('status');
      let statusTimer = null;
      function show(ok, text) {
        statusEl.textContent = text;
        statusEl.className = ok ? 'ok' : 'err';
        clearTimeout(statusTimer);
        statusTimer = setTimeout(function () { statusEl.className = ''; }, 4000);
      }

      async function save(payload) {
        const secret = secretInput.value.trim();
        if (!secret) { show(false, 'Enter the proxy secret first'); secretInput.focus(); return; }
        sessionStorage.setItem('proxySecret', secret);
        try {
          const res = await fetch('/api/config', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: 'Bearer ' + secret
            },
            body: JSON.stringify(payload)
          });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          show(true, 'Saved');
          setTimeout(function () { window.location.reload(); }, 500);
        } catch (err) {
          show(false, err.message || String(err));
        }
      }

      document.getElementById('save-logging').addEventListener('click', function () {
        save({ logging: {
          level: document.getElementById('log-level').value,
          logBodies: document.getElementById('log-bodies').checked
        } });
      });

      document.getElementById('save-vertex').addEventListener('click', function () {
        save({ vertex: {
          project: document.getElementById('vertex-project').value,
          location: document.getElementById('vertex-location').value,
          useClientParams: document.getElementById('vertex-client-params').checked
        } });
      });

      function collectUsers() {
        const users = [];
        document.querySelectorAll('[data-user-row]').forEach(function (tr) {
          const name = tr.querySelector('.u-name').textContent;
          const secret = tr.querySelector('.u-secret').value;
          if (!tr.dataset.removed) users.push({ username: name, secret });
        });
        return users;
      }

      document.querySelectorAll('.user-delete').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const tr = btn.closest('[data-user-row]');
          if (tr) { tr.dataset.removed = '1'; tr.style.opacity = '0.35'; btn.disabled = true; }
        });
      });

      document.getElementById('add-user').addEventListener('click', function () {
        const name = document.getElementById('new-user-name').value.trim();
        const secret = document.getElementById('new-user-secret').value;
        if (!name || !secret) { show(false, 'A new user needs a username and a secret'); return; }
        const users = collectUsers();
        users.push({ username: name, secret });
        save({ users });
      });

      document.getElementById('save-users').addEventListener('click', function () {
        save({ users: collectUsers() });
      });
    })();
  </script>
</body>
</html>`
}

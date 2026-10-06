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

function renderUserRows(state: PublicState): string {
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
    <div class="card">
      <h2>Logging</h2>
      <p class="detail">Detailed logging writes full request/response bodies (prompts and tokens included) at the
      <code>debug</code> level. Settings persist across restarts.</p>
      <div class="row">
        <label class="label">Log level</label>
        <select id="log-level" class="field">${options}</select>
      </div>
      <div class="row">
        <label class="label"><input type="checkbox" id="log-bodies"${state.logging.logBodies ? ' checked' : ''} /> Capture request &amp; response bodies</label>
      </div>
      <button type="button" class="btn primary" id="save-logging">Save logging</button>
    </div>`
}

function renderVertex(state: PublicState): string {
  return `
    <div class="card">
      <h2>Vertex AI settings</h2>
      <p class="detail">Takes effect on the next request. Also overridable per request when client params are allowed.</p>
      <div class="row">
        <label class="label">Project</label>
        <input id="vertex-project" class="field" value="${escapeHtml(state.vertex.project)}" />
      </div>
      <div class="row">
        <label class="label">Location</label>
        <input id="vertex-location" class="field" value="${escapeHtml(state.vertex.location)}" />
      </div>
      <div class="row">
        <label class="label"><input type="checkbox" id="vertex-client-params"${state.vertex.useClientParams ? ' checked' : ''} /> Allow client-provided project/location</label>
      </div>
      <button type="button" class="btn primary" id="save-vertex">Save vertex</button>
    </div>`
}

function renderUsers(state: PublicState): string {
  return `
    <div class="card wide">
      <h2>Proxy users</h2>
      <p class="detail">Secrets are shown masked. Leave a secret blank to keep the current one.</p>
      <table class="users">
        <colgroup><col class="c-name"><col class="c-masked"><col><col class="c-act"></colgroup>
        <thead><tr><th>Username</th><th>Secret</th><th>New secret (blank = unchanged)</th><th></th></tr></thead>
        <tbody>
          ${renderUserRows(state)}
        </tbody>
      </table>
      <div class="row add-user">
        <input id="new-user-name" class="field" placeholder="new username" />
        <input id="new-user-secret" class="field" placeholder="new secret" autocomplete="off" />
        <button type="button" class="btn" id="add-user">Add</button>
        <button type="button" class="btn primary" id="save-users">Save users</button>
      </div>
    </div>`
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
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 2rem;
    }
    h1 { text-align: center; margin-bottom: 0.5rem; font-size: 1.5rem; font-weight: 600; }
    .subtitle {
      text-align: center;
      color: #9e9e9e;
      font-size: 0.85rem;
      margin: 0 auto 1.5rem;
      max-width: 900px;
      line-height: 1.9;
    }
    .subtitle a { color: #4ecca3; text-decoration: none; }
    .subtitle code { font-size: 0.78rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 1.5rem;
      max-width: 1100px;
      margin: 0 auto;
    }
    .card { background: #16213e; border-radius: 8px; padding: 1.5rem; }
    .card.wide { grid-column: 1 / -1; }
    .card h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.75rem; }
    .detail { font-size: 0.8rem; color: #9e9e9e; margin-bottom: 0.75rem; }
    .detail code { background: #0e1726; padding: 0.1rem 0.3rem; border-radius: 3px; }
    .row { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.6rem; flex-wrap: wrap; }
    .label { font-size: 0.85rem; color: #b0b0b0; display: flex; align-items: center; gap: 0.4rem; }
    .field {
      padding: 0.4rem 0.6rem;
      border: 1px solid #2a2a4a;
      border-radius: 4px;
      background: #1a1a2e;
      color: #e0e0e0;
      font-size: 0.85rem;
      font-family: monospace;
    }
    .field:focus { outline: none; border-color: #0d47a1; }
    .btn {
      padding: 0.45rem 1rem;
      border: none;
      border-radius: 4px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      background: #2a2a4a;
      color: #e0e0e0;
    }
    .btn.primary { background: #0d47a1; }
    .btn.primary:hover { background: #1565c0; }
    .btn.danger { background: #5a1e1e; }
    .btn.danger:hover { background: #7a2e2e; }
    .btn.sm { padding: 0.3rem 0.7rem; font-size: 0.78rem; }
    table.users { width: 100%; border-collapse: collapse; margin-bottom: 0.75rem; table-layout: fixed; }
    table.users th { text-align: left; font-size: 0.75rem; color: #9e9e9e; font-weight: 500; padding: 0.25rem 0.4rem; }
    table.users td { padding: 0.35rem 0.4rem; font-size: 0.85rem; vertical-align: middle; }
    table.users .u-name, table.users .u-masked { font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    table.users .u-secret { width: 100%; }
    col.c-name { width: 16%; }
    col.c-masked { width: 14%; }
    col.c-act { width: 12%; }
    .add-user .field { flex: 1; min-width: 140px; }
    .secret-bar {
      max-width: 1100px;
      margin: 0 auto 1.5rem;
      display: flex;
      gap: 0.5rem;
      align-items: center;
      justify-content: center;
    }
    .secret-bar .hint { font-size: 0.75rem; color: #9e9e9e; }
    #status {
      position: fixed;
      bottom: 1rem;
      right: 1rem;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      background: #16213e;
      font-size: 0.85rem;
      display: none;
    }
    #status.ok { display: block; color: #4ecca3; border: 1px solid #4ecca3; }
    #status.err { display: block; color: #e57373; border: 1px solid #e57373; }
    .persisted { text-align: center; color: #666; font-size: 0.72rem; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <h1>LLM Proxy</h1>
  <p class="subtitle">
    <a href="/oauth">OAuth dashboard</a> ·
    <code>/claude/*</code> · <code>/openai/*</code> · <code>/google/*</code> ·
    <code>/vertex-ai/*</code> · <code>/taskforce/glm-5-3[-flash]/*</code> ·
    <code>/v1/messages</code> · <code>/v1/chat/completions</code>
  </p>

  <div class="secret-bar">
    <input id="admin-secret" type="password" class="field" placeholder="proxy secret (for saving)" autocomplete="off" style="width: 280px" />
    <span class="hint">stored in this browser tab only; sent as Bearer on saves</span>
  </div>

  <div class="grid">
    ${renderLogging(state)}
    ${renderVertex(state)}
    ${renderUsers(state)}
  </div>

  <p class="persisted">${persisted.length > 0 ? `persisted overrides: ${persisted.map(escapeHtml).join(', ')}` : 'no persisted overrides yet'}</p>
  <div id="status"></div>

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
        if (!secret) { show(false, 'Enter the proxy secret first'); return; }
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
        if (!name || !secret) { show(false, 'New user needs a username and a secret'); return; }
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

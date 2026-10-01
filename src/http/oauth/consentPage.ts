import type { Response } from 'express';

export interface ConsentPageOptions {
  clientName: string;
  redirectHost: string;
  /** Signed, expiring authorization request carried through the form. */
  request: string;
  error?: string;
  /** Origin of the redirect target; needed so CSP form-action allows the post-approval redirect. */
  redirectOrigin: string;
}

export function sendConsentPage(res: Response, o: ConsentPageOptions, status = 200): void {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${o.redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`,
    })
    .send(consentHtml(o));
}

export function sendMessagePage(res: Response, status: number, title: string, message: string): void {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    })
    .send(page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`));
}

function consentHtml(o: ConsentPageOptions): string {
  const error = o.error ? `<p class="error" role="alert">${escapeHtml(o.error)}</p>` : '';
  return page(
    'Connect to Gemini MCP',
    `<h1>Connect to Gemini MCP</h1>
<p><strong>${escapeHtml(o.clientName)}</strong> wants to use this Gemini server for you.</p>
<p class="muted">After you approve, you'll be sent back to <strong>${escapeHtml(o.redirectHost)}</strong>. Only continue if you started this from Claude yourself.</p>
${error}
<form method="post" action="/authorize/consent" autocomplete="off">
  <input type="hidden" name="request" value="${escapeHtml(o.request)}">
  <label for="access_key">Access key</label>
  <input id="access_key" name="access_key" type="password" autocomplete="current-password" required autofocus spellcheck="false">
  <div class="actions">
    <button type="submit" name="action" value="approve" class="primary">Approve</button>
    <button type="submit" name="action" value="deny" formnovalidate>Deny</button>
  </div>
</form>
<p class="muted small">The access key is the MCP_ACCESS_KEY value set when this server was deployed.</p>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #1d1f23; --muted: #5d6470; --accent: #1a73e8; --border: #d9dde3; --error: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15171a; --card: #1f2226; --text: #e8eaed; --muted: #a0a6ae; --accent: #8ab4f8; --border: #3a3f45; --error: #f2b8b5; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.3rem; margin: 0 0 12px; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); }
  .small { font-size: 0.85rem; margin-top: 16px; }
  .error { color: var(--error); font-weight: 600; }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; font-size: 1rem; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  button { flex: 1; padding: 10px 12px; font-size: 1rem; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  @media (prefers-color-scheme: dark) { button.primary { color: #15171a; } }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

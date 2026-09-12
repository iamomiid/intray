const STYLE = [
  ":root{color-scheme:light dark}",
  "body{margin:0;padding:3rem 1.25rem;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}",
  "main{max-width:26rem;margin:0 auto;border:1px solid GrayText;border-radius:8px;padding:1.5rem}",
  "h1{margin:0 0 .75rem;font-size:1.15rem}",
  "p{margin:0 0 1rem}",
  "label{display:block;margin-bottom:.35rem;font-size:.9rem}",
  "input{width:100%;box-sizing:border-box;padding:.55rem;font-size:1rem}",
  "button{margin-top:1rem;width:100%;padding:.6rem;font-size:1rem}",
  ".error{color:#b3261e;font-weight:600}",
  ".hint{color:GrayText;font-size:.85rem}",
].join("");

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    body,
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

function notice(message: string | null): string {
  return message === null ? "" : `<p class="error">${escapeHtml(message)}</p>`;
}

function hidden(sessionId: string, step: string): string {
  return [
    `<input type="hidden" name="session_id" value="${escapeHtml(sessionId)}">`,
    `<input type="hidden" name="step" value="${step}">`,
  ].join("");
}

export interface EmailPageInput {
  session_id: string;
  client_name: string;
  message: string | null;
}

export interface CodePageInput {
  session_id: string;
  client_name: string;
  email: string;
  message: string | null;
}

export function emailPage(input: EmailPageInput): string {
  return page(
    "Authorize an MCP client",
    [
      "<h1>Authorize an MCP client</h1>",
      `<p><strong>${escapeHtml(input.client_name)}</strong> is asking to use your intray account.`,
      " Enter the email address of the account to send it a code.</p>",
      notice(input.message),
      '<form method="post" action="/oauth/authorize">',
      hidden(input.session_id, "email"),
      '<label for="email">Email address</label>',
      '<input id="email" name="email" type="email" autocomplete="email" required>',
      '<button type="submit">Send code</button>',
      "</form>",
      '<p class="hint">Approving this mints an API key on your account. Revoke it at any time with',
      " DELETE /v1/api-keys/:key_id.</p>",
    ].join(""),
  );
}

export function codePage(input: CodePageInput): string {
  return page(
    "Enter your code",
    [
      "<h1>Enter your code</h1>",
      `<p>We emailed a 6-digit code to <strong>${escapeHtml(input.email)}</strong>.`,
      ` Enter it to let <strong>${escapeHtml(input.client_name)}</strong> connect.</p>`,
      notice(input.message),
      '<form method="post" action="/oauth/authorize">',
      hidden(input.session_id, "code"),
      '<label for="code">6-digit code</label>',
      '<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"',
      ' pattern="[0-9]{6}" maxlength="6" required>',
      '<button type="submit">Authorize</button>',
      "</form>",
      '<p class="hint">The code is valid for 10 minutes.</p>',
    ].join(""),
  );
}

export function errorPage(message: string): string {
  return page(
    "Authorization failed",
    ["<h1>Authorization failed</h1>", `<p>${escapeHtml(message)}</p>`].join(""),
  );
}

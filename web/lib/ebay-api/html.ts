// Minimal standalone HTML for the OAuth callback (a browser lands there, not
// an API client). Never includes tokens or eBay's raw error text.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function htmlPage(title: string, message: string, ok: boolean, status = ok ? 200 : 400): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
h1{font-size:1.25rem}.ok{color:#1d4ed8}.bad{color:#9f1239}</style></head>
<body><h1 class="${ok ? "ok" : "bad"}">${esc(title)}</h1><p>${esc(message)}</p>
<p><a href="/">Back to the dashboard</a></p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

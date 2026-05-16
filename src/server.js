import http from "node:http";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const appUrl = process.env.APP_URL || process.env.SHOPIFY_APP_URL || "";
const appName = "EU Product Compliance";

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);

  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function renderHome() {
  const publicUrl = appUrl ? `<p>Public URL: <code>${escapeHtml(appUrl)}</code></p>` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${appName}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        align-items: center;
        background: Canvas;
        color: CanvasText;
        display: flex;
        min-height: 100vh;
        margin: 0;
      }

      main {
        box-sizing: border-box;
        margin: 0 auto;
        max-width: 720px;
        padding: 32px;
        width: 100%;
      }

      h1 {
        font-size: clamp(2rem, 5vw, 3.5rem);
        line-height: 1;
        margin: 0 0 16px;
      }

      p {
        color: color-mix(in srgb, CanvasText 76%, transparent);
        font-size: 1rem;
        line-height: 1.6;
        margin: 0 0 12px;
      }

      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${appName}</h1>
      <p>The service is running. Shopify OAuth and scanner workflows have not been implemented yet.</p>
      ${publicUrl}
      <p>Health check: <code>/health</code></p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "eu-product-compliance"
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, 200, renderHome());
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    sendJson(res, 501, {
      ok: false,
      error: "Shopify OAuth callback is not implemented yet."
    });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: "Not found"
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`${appName} listening on port ${port}`);
});

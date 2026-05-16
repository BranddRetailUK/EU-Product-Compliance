import http from "node:http";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const appUrl = process.env.APP_URL || process.env.SHOPIFY_APP_URL || "";
const appName = "EU Product Compliance";
const apiKey = process.env.SHOPIFY_API_KEY || "";
const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-04";
const scopes = (process.env.SCOPES || "")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);

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
    "content-security-policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self' https://admin.shopify.com https://*.myshopify.com",
      "frame-ancestors https://admin.shopify.com https://*.myshopify.com",
      "img-src 'self' data: https:",
      "script-src 'self' 'unsafe-inline' https://cdn.shopify.com",
      "style-src 'self' 'unsafe-inline'",
      "upgrade-insecure-requests"
    ].join("; "),
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store"
  });
  res.end();
}

function renderAppSurface(url) {
  const page = pageForPath(url.pathname);
  const shop = normalizeShop(url.searchParams.get("shop") || "");
  const host = url.searchParams.get("host") || "";
  const embedded = url.searchParams.get("embedded") === "1";
  const hasShopifyContext = Boolean(shop || host || embedded);
  const shopLabel = shop || (host ? "Shopify admin context detected" : "No store context");
  const currentSearch = url.search || "";
  const nav = (path) => `${path}${currentSearch}`;
  const scopesLabel = scopes.length > 0 ? scopes.join(", ") : "Not configured";
  const publicUrl = appUrl || "Not configured";
  const missingApiKey = apiKey
    ? ""
    : `<div class="notice notice-warning">
        <strong>Shopify API key missing.</strong>
        Set <code>SHOPIFY_API_KEY</code> in Railway so App Bridge can initialize inside Shopify admin.
      </div>`;
  const adminContextNotice = hasShopifyContext
    ? `<div class="notice notice-success">
        <strong>Admin context active.</strong>
        This surface was opened with Shopify install context for <code>${escapeHtml(shopLabel)}</code>.
      </div>`
    : `<div class="notice">
        <strong>Standalone preview.</strong>
        Install and open the app from Shopify admin to pass store context into this surface.
      </div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="shopify-api-key" content="${escapeHtml(apiKey)}">
    <title>${appName}</title>
    <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
    <script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>
    <style>
      :root {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #202223;
        background: #f6f6f7;
      }

      body {
        margin: 0;
        background: #f6f6f7;
        color: #202223;
      }

      main {
        box-sizing: border-box;
        margin: 0;
        padding: 24px;
        width: 100%;
      }

      .shell {
        margin: 0 auto;
        max-width: 1180px;
      }

      .page-heading {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }

      h1 {
        font-size: 1.5rem;
        font-weight: 650;
        letter-spacing: 0;
        line-height: 1.25;
        margin: 0;
      }

      h2 {
        font-size: 1rem;
        font-weight: 650;
        letter-spacing: 0;
        margin: 0 0 12px;
      }

      h3 {
        font-size: 0.875rem;
        font-weight: 650;
        letter-spacing: 0;
        margin: 0 0 6px;
      }

      p {
        color: #616161;
        font-size: 0.875rem;
        line-height: 1.5;
        margin: 0;
      }

      code {
        color: #303030;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 0.8125rem;
        overflow-wrap: anywhere;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .button {
        appearance: none;
        border: 1px solid #8a8a8a;
        border-radius: 6px;
        background: #fff;
        color: #202223;
        cursor: pointer;
        font: inherit;
        font-size: 0.875rem;
        font-weight: 550;
        min-height: 32px;
        padding: 6px 12px;
      }

      .button:hover {
        background: #f1f1f1;
      }

      .button-primary {
        background: #303030;
        border-color: #303030;
        color: #fff;
      }

      .button-primary:hover {
        background: #1a1a1a;
      }

      .grid {
        display: grid;
        gap: 16px;
      }

      .grid-metrics {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .grid-main {
        align-items: start;
        grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
      }

      .panel {
        background: #fff;
        border: 1px solid #e3e3e3;
        border-radius: 8px;
        box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
        padding: 16px;
      }

      .metric {
        min-height: 92px;
      }

      .metric-value {
        color: #202223;
        display: block;
        font-size: 1.5rem;
        font-weight: 650;
        line-height: 1.2;
        margin-top: 8px;
      }

      .metric-label {
        color: #616161;
        font-size: 0.8125rem;
        margin-top: 4px;
      }

      .notice {
        background: #f7f7f7;
        border: 1px solid #d4d4d4;
        border-radius: 8px;
        color: #303030;
        font-size: 0.875rem;
        line-height: 1.45;
        margin-bottom: 16px;
        padding: 12px;
      }

      .notice-success {
        background: #f1f8f5;
        border-color: #a5d8bd;
      }

      .notice-warning {
        background: #fff8db;
        border-color: #e9d978;
      }

      .stack {
        display: grid;
        gap: 16px;
      }

      .task {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr);
        gap: 10px;
      }

      .status-dot {
        align-items: center;
        background: #f1f1f1;
        border: 1px solid #c9c9c9;
        border-radius: 50%;
        color: #303030;
        display: inline-flex;
        font-size: 0.75rem;
        font-weight: 650;
        height: 22px;
        justify-content: center;
        width: 22px;
      }

      .status-done {
        background: #008060;
        border-color: #008060;
        color: #fff;
      }

      .status-waiting {
        background: #fff;
      }

      .table {
        border-collapse: collapse;
        width: 100%;
      }

      .table th,
      .table td {
        border-bottom: 1px solid #e3e3e3;
        font-size: 0.875rem;
        padding: 12px 8px;
        text-align: left;
        vertical-align: top;
      }

      .table th {
        color: #616161;
        font-size: 0.75rem;
        font-weight: 650;
        text-transform: uppercase;
      }

      .badge {
        border: 1px solid #c9c9c9;
        border-radius: 999px;
        color: #303030;
        display: inline-flex;
        font-size: 0.75rem;
        font-weight: 550;
        line-height: 1;
        padding: 4px 8px;
      }

      .badge-success {
        background: #eaf8f2;
        border-color: #a5d8bd;
        color: #006c4f;
      }

      .badge-muted {
        background: #f7f7f7;
      }

      .definition-list {
        display: grid;
        gap: 12px;
        margin: 0;
      }

      .definition-list div {
        display: grid;
        gap: 4px;
      }

      .definition-list dt {
        color: #616161;
        font-size: 0.75rem;
        font-weight: 650;
        margin: 0;
        text-transform: uppercase;
      }

      .definition-list dd {
        font-size: 0.875rem;
        margin: 0;
        overflow-wrap: anywhere;
      }

      .empty {
        align-items: center;
        display: grid;
        min-height: 220px;
        place-items: center;
        text-align: center;
      }

      .empty-inner {
        max-width: 420px;
      }

      .tabs {
        display: none;
      }

      @media (max-width: 860px) {
        main {
          padding: 16px;
        }

        .page-heading {
          display: grid;
        }

        .grid-metrics,
        .grid-main {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <ui-title-bar title="${escapeHtml(page.title)}">
      <button onclick="openProductPicker()">Pick products</button>
      <button variant="primary" onclick="showToast('Scanner setup is next.')">Start setup</button>
    </ui-title-bar>
    <s-app-nav>
      <s-link href="${escapeHtml(nav("/"))}" rel="home">Home</s-link>
      <s-link href="${escapeHtml(nav("/products"))}">Products</s-link>
      <s-link href="${escapeHtml(nav("/settings"))}">Settings</s-link>
    </s-app-nav>
    <main>
      <div class="shell">
        <div class="page-heading">
          <div>
            <h1>${escapeHtml(page.title)}</h1>
            <p>${escapeHtml(page.description)}</p>
          </div>
          <div class="actions">
            <button class="button" type="button" onclick="openProductPicker()">Pick products</button>
            <button class="button button-primary" type="button" onclick="showToast('Scanner setup is next.')">Start setup</button>
          </div>
        </div>
        ${missingApiKey}
        ${adminContextNotice}
        ${renderPageBody(page.id, {
          hasShopifyContext,
          shopLabel,
          scopesLabel,
          publicUrl
        })}
      </div>
    </main>
    <script>
      function showToast(message) {
        if (window.shopify && typeof window.shopify.toast === "function") {
          window.shopify.toast.show(message);
          return;
        }

        window.alert(message);
      }

      async function openProductPicker() {
        if (!window.shopify || typeof window.shopify.resourcePicker !== "function") {
          showToast("Open this app inside Shopify admin to use the product picker.");
          return;
        }

        try {
          const selected = await window.shopify.resourcePicker({
            type: "product",
            multiple: true
          });

          if (selected && selected.length > 0) {
            showToast(selected.length + " product" + (selected.length === 1 ? "" : "s") + " selected.");
          }
        } catch (error) {
          console.error(error);
          showToast("Product picker was not completed.");
        }
      }
    </script>
  </body>
</html>`;
}

function renderPageBody(pageId, data) {
  if (pageId === "products") {
    return renderProductsPage(data);
  }

  if (pageId === "settings") {
    return renderSettingsPage(data);
  }

  return renderOverviewPage(data);
}

function renderOverviewPage({ hasShopifyContext, shopLabel, scopesLabel }) {
  const installStatus = hasShopifyContext ? "Connected" : "Preview";
  const installClass = hasShopifyContext ? "badge-success" : "badge-muted";
  const setupStatus = hasShopifyContext ? "status-done" : "status-waiting";

  return `<div class="grid grid-metrics">
      <section class="panel metric">
        <h2>Store</h2>
        <span class="metric-value">${escapeHtml(installStatus)}</span>
        <p class="metric-label">${escapeHtml(shopLabel)}</p>
      </section>
      <section class="panel metric">
        <h2>Products</h2>
        <span class="metric-value">Ready</span>
        <p class="metric-label">Product scan surface prepared</p>
      </section>
      <section class="panel metric">
        <h2>Scopes</h2>
        <span class="metric-value">${scopes.length || 0}</span>
        <p class="metric-label">Admin API permissions configured</p>
      </section>
      <section class="panel metric">
        <h2>Scanner</h2>
        <span class="metric-value">Pending</span>
        <p class="metric-label">Business rules are not running yet</p>
      </section>
    </div>

    <div class="grid grid-main" style="margin-top: 16px;">
      <section class="panel">
        <h2>Readiness overview</h2>
        <table class="table" aria-label="Compliance readiness overview">
          <thead>
            <tr>
              <th>Area</th>
              <th>Status</th>
              <th>Current behavior</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Admin app surface</td>
              <td><span class="badge ${installClass}">${escapeHtml(installStatus)}</span></td>
              <td>Embedded App Home renders inside Shopify admin when the app is opened.</td>
            </tr>
            <tr>
              <td>Product scanner</td>
              <td><span class="badge badge-muted">Pending</span></td>
              <td>The scanner UI exists, but no product reads, writes, or scoring run yet.</td>
            </tr>
            <tr>
              <td>Configured scopes</td>
              <td><span class="badge badge-muted">${scopes.length || 0} scopes</span></td>
              <td><code>${escapeHtml(scopesLabel)}</code></td>
            </tr>
          </tbody>
        </table>
      </section>

      <aside class="panel">
        <h2>Setup</h2>
        <div class="stack">
          <div class="task">
            <span class="status-dot ${setupStatus}">${hasShopifyContext ? "✓" : "1"}</span>
            <div>
              <h3>Open from Shopify admin</h3>
              <p>The app is ready to render as the installed App Home surface.</p>
            </div>
          </div>
          <div class="task">
            <span class="status-dot status-waiting">2</span>
            <div>
              <h3>Add authenticated data access</h3>
              <p>Next implementation step: session-token validation and token exchange.</p>
            </div>
          </div>
          <div class="task">
            <span class="status-dot status-waiting">3</span>
            <div>
              <h3>Run the first product scan</h3>
              <p>Product compliance checks will be wired after app authentication is in place.</p>
            </div>
          </div>
        </div>
      </aside>
    </div>`;
}

function renderProductsPage() {
  return `<section class="panel">
    <h2>Product readiness</h2>
    <table class="table" aria-label="Product readiness">
      <thead>
        <tr>
          <th>Product</th>
          <th>Compliance fields</th>
          <th>Customs fields</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td colspan="4">
            <div class="empty">
              <div class="empty-inner">
                <h3>No products scanned yet</h3>
                <p>Use the product picker to confirm the embedded Shopify surface is working. Product reads and compliance scoring are the next backend step.</p>
              </div>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </section>`;
}

function renderSettingsPage({ shopLabel, scopesLabel, publicUrl }) {
  return `<section class="panel">
    <h2>App configuration</h2>
    <dl class="definition-list">
      <div>
        <dt>Store context</dt>
        <dd>${escapeHtml(shopLabel)}</dd>
      </div>
      <div>
        <dt>Public URL</dt>
        <dd><code>${escapeHtml(publicUrl)}</code></dd>
      </div>
      <div>
        <dt>Admin API version</dt>
        <dd><code>${escapeHtml(apiVersion)}</code></dd>
      </div>
      <div>
        <dt>Scopes</dt>
        <dd><code>${escapeHtml(scopesLabel)}</code></dd>
      </div>
      <div>
        <dt>Install mode</dt>
        <dd>Embedded Shopify admin surface with managed-install-compatible App Home rendering.</dd>
      </div>
    </dl>
  </section>`;
}

function pageForPath(pathname) {
  if (pathname === "/products") {
    return {
      id: "products",
      title: "Products",
      description: "Choose products and review readiness once scanning is connected."
    };
  }

  if (pathname === "/settings") {
    return {
      id: "settings",
      title: "Settings",
      description: "Current Shopify app configuration and installation context."
    };
  }

  return {
    id: "overview",
    title: appName,
    description: "Installed app home for EU product compliance and customs readiness."
  };
}

function normalizeShop(value) {
  const shop = value.trim().toLowerCase();

  if (!shop) {
    return "";
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    return "";
  }

  return shop;
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
      service: "eu-product-compliance",
      surface: "shopify-app-home"
    });
    return;
  }

  if (req.method === "GET" && ["/", "/products", "/settings"].includes(url.pathname)) {
    sendHtml(res, 200, renderAppSurface(url));
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth") {
    const shop = normalizeShop(url.searchParams.get("shop") || "");

    if (!shop) {
      sendJson(res, 400, {
        ok: false,
        error: "Missing or invalid shop parameter."
      });
      return;
    }

    const embeddedAdminUrl = new URL(`https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/apps`);
    redirect(res, embeddedAdminUrl.toString());
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    sendJson(res, 501, {
      ok: false,
      error: "Authorization code callback is not implemented. This app currently expects Shopify managed installation."
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

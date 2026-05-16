import http from "node:http";
import { config, scopeLabel } from "./config.js";
import {
  databaseConfigured,
  getScanSummary,
  listScanResults,
  markShopUninstalled,
  saveScanResults
} from "./database.js";
import { scanProducts } from "./scanner.js";
import {
  authenticateAdminRequest,
  fetchProducts,
  fetchProductsByIds,
  ShopifyApiError,
  writeComplianceMetafields
} from "./shopify.js";
import {
  AuthError,
  ConfigurationError,
  normalizeShop,
  verifyWebhookHmac
} from "./security.js";

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

async function readRequestBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > limitBytes) {
      throw httpError("Request body is too large.", 413);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const raw = await readRequestBody(req);

  if (raw.length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw httpError("Request body must be valid JSON.", 400);
  }
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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
  const publicUrl = config.appUrl || "Not configured";
  const missingApiKey = config.apiKey
    ? ""
    : `<div class="notice notice-warning">
        <strong>Shopify API key missing.</strong>
        Set <code>SHOPIFY_API_KEY</code> in Railway so App Bridge can initialize inside Shopify admin.
      </div>`;
  const missingBackendConfig = config.apiSecret && config.databaseUrl && config.sessionSecret
    ? ""
    : `<div class="notice notice-warning">
        <strong>Backend auth is not fully configured.</strong>
        Set <code>SHOPIFY_API_SECRET</code>, <code>DATABASE_URL</code>, and <code>SESSION_SECRET</code> for token exchange and scanner APIs.
      </div>`;
  const adminContextNotice = hasShopifyContext
    ? `<div class="notice notice-success">
        <strong>Admin context active.</strong>
        This surface was opened with Shopify install context for <code>${escapeHtml(shopLabel)}</code>.
      </div>`
    : `<div class="notice">
        <strong>Standalone preview.</strong>
        Install and open the app from Shopify admin to pass store context and session tokens into this surface.
      </div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="shopify-api-key" content="${escapeHtml(config.apiKey)}">
    <title>${escapeHtml(page.title)}</title>
    <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
    <script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>
    <style>${appCss()}</style>
  </head>
  <body data-page="${escapeHtml(page.id)}">
    <ui-title-bar title="${escapeHtml(page.title)}">
      <button onclick="openProductPicker()">Pick products</button>
      <button variant="primary" onclick="scanVisibleProducts()">Run scan</button>
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
            <button class="button button-primary" type="button" onclick="scanVisibleProducts()">Run scan</button>
          </div>
        </div>
        ${missingApiKey}
        ${missingBackendConfig}
        ${adminContextNotice}
        <div id="app-status" class="notice">Waiting for Shopify session token.</div>
        ${renderPageBody(page.id, {
          hasShopifyContext,
          shopLabel,
          publicUrl
        })}
      </div>
    </main>
    <script>${clientScript()}</script>
  </body>
</html>`;
}

function renderPageBody(pageId, data) {
  if (pageId === "products") {
    return renderProductsPage();
  }

  if (pageId === "settings") {
    return renderSettingsPage(data);
  }

  return renderOverviewPage(data);
}

function renderOverviewPage({ hasShopifyContext, shopLabel }) {
  const installStatus = hasShopifyContext ? "Connected" : "Preview";
  const installClass = hasShopifyContext ? "badge-success" : "badge-muted";
  const setupStatus = hasShopifyContext ? "status-done" : "status-waiting";

  return `<div class="grid grid-metrics">
      <section class="panel metric">
        <h2>Store</h2>
        <span class="metric-value" id="metric-store">${escapeHtml(installStatus)}</span>
        <p class="metric-label" id="metric-shop">${escapeHtml(shopLabel)}</p>
      </section>
      <section class="panel metric">
        <h2>Scanned products</h2>
        <span class="metric-value" id="metric-scanned">0</span>
        <p class="metric-label">Saved scanner records</p>
      </section>
      <section class="panel metric">
        <h2>Ready</h2>
        <span class="metric-value" id="metric-ready">0</span>
        <p class="metric-label">Products with no blocking findings</p>
      </section>
      <section class="panel metric">
        <h2>Blocked</h2>
        <span class="metric-value" id="metric-blocked">0</span>
        <p class="metric-label">Products missing customs essentials</p>
      </section>
    </div>

    <div class="grid grid-main" style="margin-top: 16px;">
      <section class="panel">
        <h2>Recent scanner results</h2>
        <table class="table" aria-label="Recent scanner results">
          <thead>
            <tr>
              <th>Product</th>
              <th>Status</th>
              <th>Score</th>
              <th>Findings</th>
            </tr>
          </thead>
          <tbody id="recent-results">
            <tr><td colspan="4"><p>No scanner results saved yet.</p></td></tr>
          </tbody>
        </table>
      </section>

      <aside class="panel">
        <h2>Setup</h2>
        <div class="stack">
          <div class="task">
            <span class="status-dot ${setupStatus}" id="status-auth">${hasShopifyContext ? "✓" : "1"}</span>
            <div>
              <h3>Authenticate embedded app</h3>
              <p>The frontend requests a Shopify App Bridge session token and the backend verifies it.</p>
            </div>
          </div>
          <div class="task">
            <span class="status-dot status-waiting" id="status-token">2</span>
            <div>
              <h3>Exchange token</h3>
              <p>The backend exchanges the session token for an offline Admin API token and stores it encrypted.</p>
            </div>
          </div>
          <div class="task">
            <span class="status-dot status-waiting" id="status-scan">3</span>
            <div>
              <h3>Run scanner</h3>
              <p>Scanner results are written to Shopify product metafields and stored in Postgres.</p>
            </div>
          </div>
        </div>
      </aside>
    </div>`;
}

function renderProductsPage() {
  return `<section class="panel">
    <div class="section-heading">
      <div>
        <h2>Product readiness</h2>
        <p>Reads products through the Admin API, scores customs readiness, and writes results to product metafields.</p>
      </div>
      <div class="actions">
        <button class="button" type="button" onclick="loadProducts()">Refresh</button>
        <button class="button button-primary" type="button" onclick="scanVisibleProducts()">Scan visible</button>
      </div>
    </div>
    <table class="table" aria-label="Product readiness">
      <thead>
        <tr>
          <th>Product</th>
          <th>Variants</th>
          <th>Status</th>
          <th>Score</th>
          <th>Findings</th>
        </tr>
      </thead>
      <tbody id="products-tbody">
        <tr><td colspan="5"><p>Waiting for authenticated product read.</p></td></tr>
      </tbody>
    </table>
  </section>`;
}

function renderSettingsPage({ shopLabel, publicUrl }) {
  return `<section class="panel">
    <h2>App configuration</h2>
    <dl class="definition-list">
      <div>
        <dt>Store context</dt>
        <dd id="settings-shop">${escapeHtml(shopLabel)}</dd>
      </div>
      <div>
        <dt>Public URL</dt>
        <dd><code>${escapeHtml(publicUrl)}</code></dd>
      </div>
      <div>
        <dt>Admin API version</dt>
        <dd><code>${escapeHtml(config.apiVersion)}</code></dd>
      </div>
      <div>
        <dt>Scopes</dt>
        <dd><code>${escapeHtml(scopeLabel())}</code></dd>
      </div>
      <div>
        <dt>Database</dt>
        <dd id="settings-db">${databaseConfigured() ? "Configured" : "Missing DATABASE_URL"}</dd>
      </div>
      <div>
        <dt>Install mode</dt>
        <dd>Embedded Shopify admin surface using App Bridge session tokens and token exchange.</dd>
      </div>
    </dl>
  </section>`;
}

function pageForPath(pathname) {
  if (pathname === "/products") {
    return {
      id: "products",
      title: "Products",
      description: "Read, scan, and write compliance status to Shopify products."
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
    title: config.appName,
    description: "Installed app home for EU product compliance and customs readiness."
  };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/session") {
    const auth = await authenticateAdminRequest(req);
    const summary = await getScanSummary(auth.shop);
    const recentResults = await listScanResults(auth.shop, 10);

    sendJson(res, 200, {
      ok: true,
      shop: auth.shop,
      session: {
        accessMode: auth.session.accessMode,
        scopes: auth.session.scopes,
        installed: auth.session.installed,
        lastSeenAt: auth.session.lastSeenAt
      },
      summary: mapSummary(summary),
      recentResults
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/products") {
    const auth = await authenticateAdminRequest(req);
    const first = Number.parseInt(url.searchParams.get("limit") || "25", 10);
    const productsResponse = await fetchProducts(auth.session, {
      first,
      after: url.searchParams.get("after")
    });
    const scan = scanProducts(productsResponse.products);

    sendJson(res, 200, {
      ok: true,
      shop: auth.shop,
      products: productsResponse.products,
      readiness: scan.results,
      pageInfo: productsResponse.pageInfo
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/scans") {
    const auth = await authenticateAdminRequest(req);
    const results = await listScanResults(auth.shop, Number.parseInt(url.searchParams.get("limit") || "25", 10));
    const summary = await getScanSummary(auth.shop);

    sendJson(res, 200, {
      ok: true,
      shop: auth.shop,
      summary: mapSummary(summary),
      results
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/scan-products") {
    const auth = await authenticateAdminRequest(req);
    const body = await readJsonBody(req);
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    const writeMetafields = body.writeMetafields !== false;
    const products = productIds.length > 0
      ? await fetchProductsByIds(auth.session, productIds)
      : (await fetchProducts(auth.session, { first: Number.parseInt(body.limit || "25", 10) })).products;
    const scan = scanProducts(products);
    let writeResult = {
      metafieldsWritten: 0
    };

    if (writeMetafields && scan.results.length > 0) {
      writeResult = await writeComplianceMetafields(auth.session, scan.results);
    }

    if (scan.results.length > 0) {
      await saveScanResults(auth.shop, scan.results);
    }

    sendJson(res, 200, {
      ok: true,
      shop: auth.shop,
      summary: scan.summary,
      results: scan.results,
      writeResult
    });
    return true;
  }

  return false;
}

async function handleWebhook(req, res, url) {
  if (req.method !== "POST" || url.pathname !== "/webhooks/app/uninstalled") {
    return false;
  }

  const rawBody = await readRequestBody(req);
  const isVerified = verifyWebhookHmac(rawBody, req.headers["x-shopify-hmac-sha256"]);

  if (!isVerified) {
    sendJson(res, 401, {
      ok: false,
      error: "Invalid Shopify webhook signature."
    });
    return true;
  }

  const shop = normalizeShop(req.headers["x-shopify-shop-domain"] || "");

  if (shop) {
    await markShopUninstalled(shop);
  }

  sendJson(res, 200, {
    ok: true
  });
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (await handleWebhook(req, res, url)) {
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (await handleApi(req, res, url)) {
        return;
      }

      sendJson(res, 404, {
        ok: false,
        error: "API route not found."
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "eu-product-compliance",
        surface: "shopify-app-home",
        databaseConfigured: databaseConfigured()
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
        error: "Authorization code callback is not implemented. This app uses Shopify managed installation plus token exchange."
      });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "Not found"
    });
  } catch (error) {
    handleError(res, error);
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`${config.appName} listening on port ${config.port}`);
});

function handleError(res, error) {
  const statusCode = error.statusCode || 500;
  const isExpected =
    error instanceof AuthError ||
    error instanceof ConfigurationError ||
    error instanceof ShopifyApiError ||
    statusCode < 500;

  if (!isExpected) {
    console.error(error);
  }

  sendJson(res, statusCode, {
    ok: false,
    error: error.message || "Internal server error.",
    details: error instanceof ShopifyApiError ? error.details : undefined
  });
}

function mapSummary(summary) {
  return {
    scannedProducts: summary.scanned_products || 0,
    readyProducts: summary.ready_products || 0,
    needsAttentionProducts: summary.needs_attention_products || 0,
    blockedProducts: summary.blocked_products || 0,
    lastScanAt: summary.last_scan_at || null
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function appCss() {
  return `
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

    .page-heading,
    .section-heading {
      align-items: flex-start;
      display: flex;
      gap: 16px;
      justify-content: space-between;
      margin-bottom: 18px;
    }

    h1,
    h2,
    h3,
    p {
      letter-spacing: 0;
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 650;
      line-height: 1.25;
      margin: 0;
    }

    h2 {
      font-size: 1rem;
      font-weight: 650;
      margin: 0 0 12px;
    }

    h3 {
      font-size: 0.875rem;
      font-weight: 650;
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
      background: #fff;
      border: 1px solid #8a8a8a;
      border-radius: 6px;
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

    .notice-critical {
      background: #fff4f4;
      border-color: #e0b3b2;
    }

    .stack {
      display: grid;
      gap: 16px;
    }

    .task {
      display: grid;
      gap: 10px;
      grid-template-columns: 24px minmax(0, 1fr);
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
      text-transform: capitalize;
    }

    .badge-success {
      background: #eaf8f2;
      border-color: #a5d8bd;
      color: #006c4f;
    }

    .badge-warning {
      background: #fff8db;
      border-color: #e9d978;
      color: #5c4100;
    }

    .badge-critical {
      background: #fff4f4;
      border-color: #e0b3b2;
      color: #8e1f0b;
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

    @media (max-width: 860px) {
      main {
        padding: 16px;
      }

      .page-heading,
      .section-heading {
        display: grid;
      }

      .grid-metrics,
      .grid-main {
        grid-template-columns: 1fr;
      }
    }
  `;
}

function clientScript() {
  return `
    const state = {
      page: document.body.dataset.page,
      products: [],
      selectedProductIds: []
    };

    document.addEventListener("DOMContentLoaded", () => {
      bootstrap().catch((error) => setStatus(error.message, "critical"));
    });

    async function bootstrap() {
      const data = await apiFetch("/api/session");

      setStatus("Authenticated with Shopify session token. Offline Admin API session is stored.", "success");
      setText("metric-store", "Connected");
      setText("metric-shop", data.shop || "Connected store");
      setText("metric-scanned", data.summary?.scannedProducts ?? 0);
      setText("metric-ready", data.summary?.readyProducts ?? 0);
      setText("metric-blocked", data.summary?.blockedProducts ?? 0);
      setText("settings-shop", data.shop || "Connected store");
      setText("settings-db", "Configured and reachable");
      markStep("status-auth");
      markStep("status-token");
      renderRecentResults(data.recentResults || []);

      if (state.page === "products") {
        await loadProducts();
      }
    }

    async function apiFetch(path, options = {}) {
      const token = await getSessionToken();
      const headers = new Headers(options.headers || {});

      if (!headers.has("content-type") && options.body) {
        headers.set("content-type", "application/json");
      }

      if (token) {
        headers.set("authorization", "Bearer " + token);
      }

      const response = await fetch(path, {
        ...options,
        headers
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || "Request failed.");
      }

      return payload;
    }

    async function getSessionToken() {
      if (window.shopify && typeof window.shopify.idToken === "function") {
        return window.shopify.idToken();
      }

      return "";
    }

    async function loadProducts() {
      const tbody = document.getElementById("products-tbody");

      if (!tbody) {
        return;
      }

      tbody.innerHTML = '<tr><td colspan="5"><p>Loading products from Shopify...</p></td></tr>';

      try {
        const data = await apiFetch("/api/products?limit=25");
        state.products = data.products || [];
        renderProducts(data.readiness || []);
      } catch (error) {
        tbody.innerHTML = '<tr><td colspan="5"><p>' + escapeHtml(error.message) + '</p></td></tr>';
        setStatus(error.message, "critical");
      }
    }

    async function openProductPicker() {
      if (!window.shopify || typeof window.shopify.resourcePicker !== "function") {
        setStatus("Open this app inside Shopify admin to use the product picker.", "warning");
        return;
      }

      try {
        const selected = await window.shopify.resourcePicker({
          type: "product",
          multiple: true
        });

        state.selectedProductIds = (selected || []).map((product) => product.id).filter(Boolean);

        if (state.selectedProductIds.length > 0) {
          showToast(state.selectedProductIds.length + " product" + (state.selectedProductIds.length === 1 ? "" : "s") + " selected.");
          await scanSelectedProducts();
        }
      } catch (error) {
        console.error(error);
        setStatus("Product picker was not completed.", "warning");
      }
    }

    async function scanVisibleProducts() {
      const productIds = state.products.map((product) => product.id);
      await runScan(productIds);
    }

    async function scanSelectedProducts() {
      await runScan(state.selectedProductIds);
    }

    async function runScan(productIds) {
      setStatus("Scanning products and writing compliance metafields...", "warning");

      try {
        const data = await apiFetch("/api/scan-products", {
          method: "POST",
          body: JSON.stringify({
            productIds,
            writeMetafields: true
          })
        });

        markStep("status-scan");
        setStatus("Scan complete. Wrote " + data.writeResult.metafieldsWritten + " Shopify metafields.", "success");
        setText("metric-scanned", data.summary?.scannedProducts ?? productIds.length);
        setText("metric-ready", data.summary?.readyProducts ?? 0);
        setText("metric-blocked", data.summary?.blockedProducts ?? 0);
        renderProducts(data.results || []);
        renderRecentResults((data.results || []).map((result) => ({
          title: result.product.title,
          handle: result.product.handle,
          status: result.status,
          score: result.score,
          findings: result.findings,
          scannedAt: result.scannedAt
        })));
      } catch (error) {
        setStatus(error.message, "critical");
      }
    }

    function renderProducts(results) {
      const tbody = document.getElementById("products-tbody");

      if (!tbody) {
        return;
      }

      if (!results.length) {
        tbody.innerHTML = '<tr><td colspan="5"><p>No products found.</p></td></tr>';
        return;
      }

      tbody.innerHTML = results.map((result) => {
        const product = result.product;
        return '<tr>' +
          '<td><strong>' + escapeHtml(product.title || "Untitled product") + '</strong><br><p>' + escapeHtml(product.handle || product.id) + '</p></td>' +
          '<td>' + escapeHtml(String((product.variants || []).length)) + '</td>' +
          '<td>' + statusBadge(result.status) + '</td>' +
          '<td>' + escapeHtml(String(result.score)) + '</td>' +
          '<td>' + renderFindings(result.findings) + '</td>' +
        '</tr>';
      }).join("");
    }

    function renderRecentResults(results) {
      const tbody = document.getElementById("recent-results");

      if (!tbody) {
        return;
      }

      if (!results.length) {
        tbody.innerHTML = '<tr><td colspan="4"><p>No scanner results saved yet.</p></td></tr>';
        return;
      }

      tbody.innerHTML = results.map((result) => '<tr>' +
        '<td><strong>' + escapeHtml(result.title || result.product?.title || "Untitled product") + '</strong><br><p>' + escapeHtml(result.handle || result.product?.handle || "") + '</p></td>' +
        '<td>' + statusBadge(result.status) + '</td>' +
        '<td>' + escapeHtml(String(result.score)) + '</td>' +
        '<td>' + renderFindings(result.findings || []) + '</td>' +
      '</tr>').join("");
    }

    function renderFindings(findings) {
      if (!findings || findings.length === 0) {
        return '<span class="badge badge-success">No findings</span>';
      }

      return findings.slice(0, 3).map((finding) =>
        '<p><strong>' + escapeHtml(finding.severity) + ':</strong> ' + escapeHtml(finding.message) + '</p>'
      ).join("") + (findings.length > 3 ? '<p>+' + (findings.length - 3) + ' more</p>' : '');
    }

    function statusBadge(status) {
      const className = status === "ready"
        ? "badge-success"
        : status === "blocked"
          ? "badge-critical"
          : "badge-warning";
      return '<span class="badge ' + className + '">' + escapeHtml(String(status || "unknown").replaceAll("_", " ")) + '</span>';
    }

    function setStatus(message, tone = "") {
      const el = document.getElementById("app-status");

      if (!el) {
        return;
      }

      el.className = "notice" + (tone ? " notice-" + tone : "");
      el.textContent = message;
    }

    function setText(id, value) {
      const el = document.getElementById(id);

      if (el) {
        el.textContent = value;
      }
    }

    function markStep(id) {
      const el = document.getElementById(id);

      if (el) {
        el.classList.add("status-done");
        el.textContent = "✓";
      }
    }

    function showToast(message) {
      if (window.shopify && window.shopify.toast && typeof window.shopify.toast.show === "function") {
        window.shopify.toast.show(message);
        return;
      }

      setStatus(message);
    }

    function escapeHtml(value) {
      return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }
  `;
}

import http from "node:http";
import { aiScanningConfigured, enhanceScanResultsWithAi, summarizeAiStatus } from "./ai.js";
import { config } from "./config.js";
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
  const shopLabel = shop || (host ? "Shopify admin context detected" : "No store context");
  const currentSearch = url.search || "";
  const nav = (path) => `${path}${currentSearch}`;

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
        <div id="app-status" class="notice notice-hidden" role="status"></div>
        ${renderPageBody(page.id, {
          shopLabel
        })}
      </div>
    </main>
    ${renderScanOverlay()}
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

function renderOverviewPage() {
  return `<div class="grid grid-metrics">
      <section class="panel metric">
        <h2>Scanned</h2>
        <span class="metric-value" id="metric-scanned">0</span>
        <p class="metric-label">Products reviewed</p>
      </section>
      <section class="panel metric">
        <h2>Ready</h2>
        <span class="metric-value" id="metric-ready">0</span>
        <p class="metric-label">No blocking findings</p>
      </section>
      <section class="panel metric">
        <h2>Needs review</h2>
        <span class="metric-value" id="metric-attention">0</span>
        <p class="metric-label">Products to complete</p>
      </section>
      <section class="panel metric">
        <h2>Blocked</h2>
        <span class="metric-value" id="metric-blocked">0</span>
        <p class="metric-label">Missing customs essentials</p>
      </section>
    </div>

    ${renderFixIssuesPanel()}

    <section class="panel panel-offset">
      <div class="section-heading">
        <div>
          <h2>Recent product reviews</h2>
          <p>Saved results from your latest customs readiness scans.</p>
        </div>
        <div class="actions">
          <button class="button" type="button" onclick="openProductPicker()">Pick products</button>
          <button class="button button-primary" type="button" onclick="scanVisibleProducts()">Run scan</button>
        </div>
      </div>
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
    </section>`;
}

function renderProductsPage() {
  return `${renderFixIssuesPanel()}
  <section class="panel">
    <div class="section-heading">
      <div>
        <h2>Customs readiness</h2>
        <p>Review product data before cross-border selling. Scans check Shopify fields and add AI-assisted recommendations when available.</p>
      </div>
      <div class="actions">
        <button class="button" type="button" onclick="loadProducts()">Refresh</button>
        <button class="button button-primary" type="button" onclick="scanVisibleProducts()">Scan listed products</button>
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
        <tr><td colspan="5"><p>Products will appear here after loading.</p></td></tr>
      </tbody>
    </table>
  </section>`;
}

function renderFixIssuesPanel() {
  return `<section class="panel fix-panel panel-offset">
    <div>
      <h2>Fix issues</h2>
      <p id="fix-issues-summary">Run a scan to review product issues before applying updates.</p>
    </div>
    <div class="fix-actions">
      <span class="badge badge-muted" id="fix-issues-count">0 issues</span>
      <button class="button button-primary" id="fix-issues-button" type="button" onclick="fixVisibleIssues()" disabled>Fix issues</button>
    </div>
  </section>`;
}

function renderSettingsPage({ shopLabel }) {
  const aiStatus = aiScanningConfigured() ? "Enabled" : "Off";
  const aiClass = aiScanningConfigured() ? "badge-success" : "badge-muted";

  return `<section class="panel">
    <div class="section-heading">
      <div>
        <h2>Scan coverage</h2>
        <p>Current checks used when reviewing products for EU customs readiness.</p>
      </div>
      <span class="badge ${aiClass}" id="settings-ai">AI review ${aiStatus}</span>
    </div>
    <div class="coverage-grid">
      <div class="coverage-item">
        <span class="coverage-icon">1</span>
        <div>
          <h3>Product details</h3>
          <p>Vendor and product type are checked for classification context.</p>
        </div>
      </div>
      <div class="coverage-item">
        <span class="coverage-icon">2</span>
        <div>
          <h3>Variant identifiers</h3>
          <p>SKUs and barcodes are reviewed for traceability and warehouse matching.</p>
        </div>
      </div>
      <div class="coverage-item">
        <span class="coverage-icon">3</span>
        <div>
          <h3>Customs data</h3>
          <p>HS codes and country of origin are checked on shipping-required variants.</p>
        </div>
      </div>
      <div class="coverage-item">
        <span class="coverage-icon">4</span>
        <div>
          <h3>Saved results</h3>
          <p>Scans save readiness results, and product metafields are updated only from Fix issues.</p>
        </div>
      </div>
    </div>
    <p class="muted-note" id="settings-shop">Connected store: ${escapeHtml(shopLabel)}</p>
  </section>`;
}

function renderScanOverlay() {
  return `<div class="scan-overlay" id="scan-overlay" hidden>
    <div class="scan-dialog" role="status" aria-live="polite">
      <div class="scan-orbit" id="scan-orbit" style="--scan-progress: 0deg; --scan-progress-tail: 0deg;">
        <div class="scan-spinner"></div>
        <div class="scan-core">
          <strong id="scan-progress">0%</strong>
          <span id="scan-message">Preparing scan</span>
        </div>
      </div>
      <p id="scan-detail">Checking product data.</p>
    </div>
  </div>`;
}

function pageForPath(pathname) {
  if (pathname === "/products") {
    return {
      id: "products",
      title: "Products",
      description: "Check product data before applying product updates."
    };
  }

  if (pathname === "/settings") {
    return {
      id: "settings",
      title: "Settings",
      description: "Review what each scan checks."
    };
  }

  return {
    id: "overview",
    title: config.appName,
    description: "Track EU customs readiness across your product catalogue."
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
      aiConfigured: aiScanningConfigured(),
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
      aiConfigured: aiScanningConfigured(),
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
    const products = productIds.length > 0
      ? await fetchProductsByIds(auth.session, productIds)
      : (await fetchProducts(auth.session, { first: Number.parseInt(body.limit || "25", 10) })).products;
    const ruleScan = scanProducts(products);
    const scanResults = await enhanceScanResultsWithAi(ruleScan.results);
    const aiStatus = summarizeAiStatus(scanResults);

    if (scanResults.length > 0) {
      await saveScanResults(auth.shop, scanResults);
    }

    sendJson(res, 200, {
      ok: true,
      shop: auth.shop,
      aiStatus,
      summary: ruleScan.summary,
      results: scanResults,
      writeResult: {
        metafieldsWritten: 0
      },
      productUpdatesApplied: false
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/fix-issues") {
    const auth = await authenticateAdminRequest(req);
    const body = await readJsonBody(req);
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    const products = productIds.length > 0
      ? await fetchProductsByIds(auth.session, productIds)
      : (await fetchProducts(auth.session, { first: Number.parseInt(body.limit || "25", 10) })).products;
    const ruleScan = scanProducts(products);
    const scanResults = await enhanceScanResultsWithAi(ruleScan.results);
    const aiStatus = summarizeAiStatus(scanResults);
    const writeResult = scanResults.length > 0
      ? await writeComplianceMetafields(auth.session, scanResults)
      : { metafieldsWritten: 0 };

    if (scanResults.length > 0) {
      await saveScanResults(auth.shop, scanResults);
    }

    sendJson(res, 200, {
      ok: true,
      shop: auth.shop,
      aiStatus,
      summary: ruleScan.summary,
      results: scanResults,
      writeResult,
      productUpdatesApplied: true
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

    @property --scan-progress {
      syntax: "<angle>";
      inherits: false;
      initial-value: 0deg;
    }

    @property --scan-progress-tail {
      syntax: "<angle>";
      inherits: false;
      initial-value: 0deg;
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

    .button:disabled {
      cursor: wait;
      opacity: 0.7;
    }

    .grid {
      display: grid;
      gap: 16px;
    }

    .grid-metrics {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .panel {
      background: #fff;
      border: 1px solid #e3e3e3;
      border-radius: 8px;
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
      padding: 16px;
    }

    .panel-offset {
      margin-top: 16px;
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

    .notice-hidden {
      display: none;
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

    .table th:last-child,
    .table td:last-child {
      width: 48%;
    }

    .product-cell {
      align-items: center;
      display: grid;
      gap: 12px;
      grid-template-columns: 54px minmax(0, 1fr);
      min-width: 230px;
    }

    .product-thumb {
      aspect-ratio: 1;
      background: #f1f2f4;
      border: 1px solid #d4d4d4;
      border-radius: 6px;
      color: #616161;
      display: block;
      font-size: 0.75rem;
      font-weight: 650;
      height: 54px;
      line-height: 54px;
      object-fit: cover;
      text-align: center;
      width: 54px;
    }

    .product-title {
      color: #202223;
      display: block;
      font-weight: 650;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }

    .fix-panel {
      align-items: center;
      display: flex;
      gap: 16px;
      justify-content: space-between;
    }

    .fix-actions {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
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

    .coverage-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .coverage-item {
      align-items: start;
      display: grid;
      gap: 12px;
      grid-template-columns: 28px minmax(0, 1fr);
    }

    .coverage-icon {
      align-items: center;
      background: #eaf8f2;
      border: 1px solid #a5d8bd;
      border-radius: 50%;
      color: #006c4f;
      display: inline-flex;
      font-size: 0.75rem;
      font-weight: 650;
      height: 26px;
      justify-content: center;
      width: 26px;
    }

    .muted-note {
      border-top: 1px solid #e3e3e3;
      margin-top: 16px;
      padding-top: 12px;
    }

    .finding-list {
      display: grid;
      gap: 6px;
    }

    .finding-source {
      color: #006c4f;
      font-weight: 650;
    }

    .finding-item {
      align-items: start;
      display: grid;
      gap: 8px;
      grid-template-columns: auto minmax(0, 1fr);
    }

    .severity-pill {
      border-radius: 999px;
      font-size: 0.6875rem;
      font-weight: 650;
      line-height: 1;
      min-width: 48px;
      padding: 5px 7px;
      text-align: center;
      text-transform: uppercase;
    }

    .severity-high {
      background: #fff4f4;
      color: #8e1f0b;
    }

    .severity-medium {
      background: #fff8db;
      color: #5c4100;
    }

    .severity-low {
      background: #f1f2f4;
      color: #616161;
    }

    .finding-extra {
      display: grid;
      gap: 6px;
    }

    .finding-extra[hidden] {
      display: none;
    }

    .finding-toggle {
      align-items: center;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.65), #f7f7f7);
      border: 1px solid #d4d4d4;
      border-radius: 6px;
      color: #303030;
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      font-size: 0.8125rem;
      font-weight: 550;
      gap: 8px;
      justify-content: space-between;
      margin-top: 2px;
      min-height: 30px;
      padding: 5px 9px;
      width: fit-content;
    }

    .finding-toggle:hover {
      background: #f1f1f1;
    }

    .finding-chevron {
      border-bottom: 2px solid currentColor;
      border-right: 2px solid currentColor;
      display: inline-block;
      height: 7px;
      margin-top: -3px;
      transform: rotate(45deg);
      transition: transform 160ms ease;
      width: 7px;
    }

    .finding-toggle.is-expanded .finding-chevron {
      margin-top: 3px;
      transform: rotate(225deg);
    }

    .scan-overlay {
      align-items: center;
      backdrop-filter: blur(6px);
      background: rgba(246, 246, 247, 0.86);
      display: grid;
      inset: 0;
      justify-items: center;
      position: fixed;
      z-index: 1000;
    }

    .scan-overlay[hidden] {
      display: none;
    }

    .scan-dialog {
      align-items: center;
      background: #fff;
      border: 1px solid #d4d4d4;
      border-radius: 8px;
      box-shadow: 0 18px 54px rgba(0, 0, 0, 0.18);
      display: grid;
      gap: 18px;
      justify-items: center;
      max-width: min(360px, calc(100vw - 32px));
      padding: 28px;
      text-align: center;
      width: 100%;
    }

    .scan-orbit {
      --scan-progress: 0deg;
      --scan-progress-tail: 0deg;
      align-items: center;
      aspect-ratio: 1;
      background:
        conic-gradient(
          from -90deg,
          #008060 0deg,
          #00a47a var(--scan-progress-tail),
          #9bf4cf var(--scan-progress),
          #dfe3e8 var(--scan-progress),
          #dfe3e8 360deg
        );
      border-radius: 50%;
      display: grid;
      justify-items: center;
      position: relative;
      transition:
        --scan-progress 720ms cubic-bezier(0.65, 0, 0.35, 1),
        --scan-progress-tail 720ms cubic-bezier(0.65, 0, 0.35, 1);
      width: 220px;
    }

    .scan-orbit::before {
      background: #fff;
      border-radius: 50%;
      box-shadow: inset 0 0 0 1px #e3e3e3;
      content: "";
      inset: 14px;
      position: absolute;
    }

    .scan-spinner {
      border-radius: 50%;
      inset: 0;
      position: absolute;
      transform: rotate(var(--scan-progress));
      transition: transform 720ms cubic-bezier(0.65, 0, 0.35, 1);
    }

    .scan-spinner::after {
      background: radial-gradient(circle at 35% 35%, #ffffff 0 12%, #baf8dc 13% 34%, #00a47a 35% 100%);
      border: 3px solid #fff;
      border-radius: 50%;
      box-shadow: 0 2px 12px rgba(0, 128, 96, 0.4);
      content: "";
      height: 14px;
      left: calc(50% - 10px);
      position: absolute;
      top: -2px;
      width: 14px;
    }

    .scan-core {
      align-items: center;
      display: grid;
      gap: 8px;
      justify-items: center;
      max-width: 140px;
      position: relative;
      z-index: 1;
    }

    .scan-core strong {
      color: #202223;
      font-size: 2rem;
      font-weight: 700;
      line-height: 1;
    }

    .scan-core span {
      color: #303030;
      font-size: 0.875rem;
      font-weight: 650;
      line-height: 1.25;
    }

    @media (max-width: 860px) {
      main {
        padding: 16px;
      }

      .page-heading,
      .section-heading {
        display: grid;
      }

      .grid-metrics {
        grid-template-columns: 1fr;
      }

      .coverage-grid {
        grid-template-columns: 1fr;
      }

      .fix-panel {
        align-items: stretch;
        display: grid;
      }

      .fix-actions {
        justify-content: flex-start;
      }

      .scan-orbit {
        width: 190px;
      }
    }
  `;
}

function clientScript() {
  return `
    const state = {
      page: document.body.dataset.page,
      products: [],
      currentResults: [],
      recentResults: [],
      selectedProductIds: [],
      scanTimer: null,
      scanProgress: 0
    };

    document.addEventListener("DOMContentLoaded", () => {
      bootstrap().catch((error) => setStatus(error.message, "critical"));
    });

    async function bootstrap() {
      const data = await apiFetch("/api/session");

      setText("metric-scanned", data.summary?.scannedProducts ?? 0);
      setText("metric-ready", data.summary?.readyProducts ?? 0);
      setText("metric-attention", data.summary?.needsAttentionProducts ?? 0);
      setText("metric-blocked", data.summary?.blockedProducts ?? 0);
      setText("settings-shop", "Connected store: " + (data.shop || "Shopify admin"));
      setText("settings-ai", "AI review " + (data.aiConfigured ? "Enabled" : "Off"));
      state.recentResults = data.recentResults || [];

      if (state.page !== "products") {
        state.currentResults = state.recentResults;
      }

      renderRecentResults(state.recentResults);
      updateFixPanel();

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
        throw new Error(formatApiError(payload));
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
        state.currentResults = data.readiness || [];
        renderProducts(state.currentResults);
        updateFixPanel();
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

    async function fixVisibleIssues() {
      const productIds = currentIssueProductIds();

      if (productIds.length === 0) {
        setStatus("Run a scan with product issues before applying updates.", "warning");
        updateFixPanel();
        return;
      }

      setStatus("");
      showScanOverlay(productIds.length, "fix");

      try {
        const data = await apiFetch("/api/fix-issues", {
          method: "POST",
          body: JSON.stringify({
            productIds
          })
        });

        setText("metric-scanned", data.summary?.scannedProducts ?? productIds.length);
        setText("metric-ready", data.summary?.readyProducts ?? 0);
        setText("metric-attention", data.summary?.needsAttentionProducts ?? 0);
        setText("metric-blocked", data.summary?.blockedProducts ?? 0);
        state.currentResults = data.results || [];
        state.recentResults = state.currentResults.map(toRecentResult);
        renderProducts(state.currentResults);
        renderRecentResults(state.recentResults);
        updateFixPanel();
        hideScanOverlay(true, "fix");
        showToast("Product updates complete for " + state.currentResults.length + " products.");
      } catch (error) {
        hideScanOverlay(false, "fix");
        setStatus(error.message, "critical");
      }
    }

    async function runScan(productIds) {
      setStatus("");
      showScanOverlay(productIds.length || state.products.length || 25, "scan");

      try {
        const data = await apiFetch("/api/scan-products", {
          method: "POST",
          body: JSON.stringify({
            productIds
          })
        });

        setText("metric-scanned", data.summary?.scannedProducts ?? productIds.length);
        setText("metric-ready", data.summary?.readyProducts ?? 0);
        setText("metric-attention", data.summary?.needsAttentionProducts ?? 0);
        setText("metric-blocked", data.summary?.blockedProducts ?? 0);
        state.currentResults = data.results || [];
        state.recentResults = state.currentResults.map(toRecentResult);
        renderProducts(state.currentResults);
        renderRecentResults(state.recentResults);
        updateFixPanel();
        hideScanOverlay(true, "scan");
        showToast("Scan complete. Reviewed " + (data.results || []).length + " products.");
      } catch (error) {
        hideScanOverlay(false, "scan");
        setStatus(error.message, "critical");
      }
    }

    function showScanOverlay(totalProducts, mode = "scan") {
      const overlay = document.getElementById("scan-overlay");

      if (!overlay) {
        return;
      }

      const messages = mode === "fix"
        ? [
            "Preparing product updates",
            "Checking latest product data",
            "Writing compliance metafields",
            "Saving readiness results"
          ]
        : [
            "Collecting product data",
            "Checking variant identifiers",
            "Reviewing HS code coverage",
            "Assessing origin data",
            "Running AI customs review",
            "Preparing issue report"
          ];

      state.scanProgress = 3;
      overlay.hidden = false;
      setActionButtonsDisabled(true);
      updateScanOverlay(state.scanProgress, messages[0], "Reviewing " + totalProducts + " product" + (totalProducts === 1 ? "" : "s") + ".");
      clearInterval(state.scanTimer);
      state.scanTimer = setInterval(() => {
        const nextProgress = Math.min(92, state.scanProgress + 5 + Math.round(Math.random() * 8));
        const messageIndex = Math.min(messages.length - 1, Math.floor(nextProgress / 17));
        state.scanProgress = nextProgress;
        updateScanOverlay(
          state.scanProgress,
          messages[messageIndex],
          mode === "fix" ? "Applying product updates." : "Scanning product records and compliance fields."
        );
      }, 850);
    }

    function hideScanOverlay(success, mode = "scan") {
      const overlay = document.getElementById("scan-overlay");

      clearInterval(state.scanTimer);
      state.scanTimer = null;
      setActionButtonsDisabled(false);

      if (!overlay) {
        return;
      }

      updateScanOverlay(
        success ? 100 : 0,
        success ? (mode === "fix" ? "Updates complete" : "Scan complete") : (mode === "fix" ? "Updates stopped" : "Scan stopped"),
        success ? (mode === "fix" ? "Product updates are complete." : "Results are ready to review.") : "The request could not be completed."
      );
      window.setTimeout(() => {
        overlay.hidden = true;
      }, success ? 500 : 250);
    }

    function updateScanOverlay(progress, message, detail) {
      const orbit = document.getElementById("scan-orbit");
      const clampedProgress = Math.max(0, Math.min(progress, 100));
      const angle = clampedProgress * 3.6;
      const headFade = Math.min(42, Math.max(14, angle * 0.18));
      const tailAngle = Math.max(0, angle - headFade);

      if (orbit) {
        orbit.style.setProperty("--scan-progress", angle + "deg");
        orbit.style.setProperty("--scan-progress-tail", tailAngle + "deg");
      }

      setText("scan-progress", clampedProgress + "%");
      setText("scan-message", message);
      setText("scan-detail", detail);
    }

    function setActionButtonsDisabled(disabled) {
      document.querySelectorAll("button").forEach((button) => {
        if (disabled) {
          button.dataset.wasDisabled = button.disabled ? "true" : "false";
          button.disabled = true;
          return;
        }

        button.disabled = button.dataset.wasDisabled === "true";
        delete button.dataset.wasDisabled;
      });

      if (!disabled) {
        updateFixPanel();
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

      tbody.innerHTML = results.map((result, index) => {
        const product = result.product;
        return '<tr>' +
          '<td>' + renderProductCell(product) + '</td>' +
          '<td>' + escapeHtml(String((product.variants || []).length)) + '</td>' +
          '<td>' + statusBadge(result.status) + '</td>' +
          '<td>' + escapeHtml(String(result.score)) + '</td>' +
          '<td>' + renderFindings(result.findings, result.aiReview, "product-" + index) + '</td>' +
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

      tbody.innerHTML = results.map((result, index) => '<tr>' +
        '<td>' + renderProductCell(normalizeResultProduct(result)) + '</td>' +
        '<td>' + statusBadge(result.status) + '</td>' +
        '<td>' + escapeHtml(String(result.score)) + '</td>' +
        '<td>' + renderFindings(result.findings || [], result.aiReview, "recent-" + index) + '</td>' +
      '</tr>').join("");
    }

    function renderFindings(findings, aiReview = null, idSuffix = "findings") {
      const sortedFindings = sortFindings(findings || []);

      if (sortedFindings.length === 0) {
        const aiSummary = aiReview?.summary ? '<p><span class="finding-source">AI</span> ' + escapeHtml(aiReview.summary) + '</p>' : "";
        return '<span class="badge badge-success">No findings</span>' + aiSummary;
      }

      const aiSummary = aiReview?.summary ? '<p><span class="finding-source">AI</span> ' + escapeHtml(aiReview.summary) + '</p>' : "";
      const visibleFindings = sortedFindings.slice(0, 3);
      const extraFindings = sortedFindings.slice(3);
      const extraId = "finding-extra-" + idSuffix;
      const toggle = extraFindings.length > 0
        ? '<button class="finding-toggle" type="button" onclick="toggleFindings(this)" aria-expanded="false" aria-controls="' + escapeHtml(extraId) + '" data-more-label="Show ' + extraFindings.length + ' more issue' + (extraFindings.length === 1 ? "" : "s") + '" data-less-label="Show fewer issues"><span class="toggle-label">Show ' + extraFindings.length + ' more issue' + (extraFindings.length === 1 ? "" : "s") + '</span><span class="finding-chevron" aria-hidden="true"></span></button>' +
          '<div class="finding-extra" id="' + escapeHtml(extraId) + '" hidden>' + extraFindings.map(renderFindingItem).join("") + '</div>'
        : "";

      return '<div class="finding-list">' + aiSummary + visibleFindings.map(renderFindingItem).join("") + toggle + '</div>';
    }

    function renderFindingItem(finding) {
      const severity = normalizeSeverity(finding.severity);
      const source = finding.source === "ai" ? '<span class="finding-source">AI</span> ' : "";
      return '<div class="finding-item">' +
        '<span class="severity-pill severity-' + escapeHtml(severity) + '">' + escapeHtml(severity) + '</span>' +
        '<p>' + source + escapeHtml(finding.message || "") + '</p>' +
      '</div>';
    }

    function renderProductCell(product) {
      const title = product.title || "Untitled product";
      const detail = product.handle || product.id || "";

      return '<div class="product-cell">' +
        renderProductThumbnail(product) +
        '<div><span class="product-title">' + escapeHtml(title) + '</span><p>' + escapeHtml(detail) + '</p></div>' +
      '</div>';
    }

    function renderProductThumbnail(product) {
      const image = product.image || null;

      if (image?.url) {
        const altText = image.altText || product.title || "";
        return '<img class="product-thumb" src="' + escapeHtml(image.url) + '" alt="' + escapeHtml(altText) + '" loading="lazy">';
      }

      return '<span class="product-thumb" aria-hidden="true">' + escapeHtml(productInitial(product.title)) + '</span>';
    }

    function normalizeResultProduct(result) {
      const product = result.product || {};

      return {
        id: product.id || result.productId || "",
        title: product.title || result.title || "Untitled product",
        handle: product.handle || result.handle || "",
        image: product.image || result.image || null,
        variants: product.variants || []
      };
    }

    function toRecentResult(result) {
      return {
        productId: result.product?.id || result.productId || "",
        title: result.product?.title || result.title || "Untitled product",
        handle: result.product?.handle || result.handle || "",
        image: result.product?.image || result.image || null,
        status: result.status,
        score: result.score,
        findings: result.findings,
        aiReview: result.aiReview,
        scannedAt: result.scannedAt
      };
    }

    function productInitial(title) {
      const trimmed = String(title || "").trim();
      return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
    }

    function sortFindings(findings) {
      const priority = {
        high: 0,
        medium: 1,
        low: 2
      };

      return [...(findings || [])].sort((left, right) => {
        const leftPriority = priority[normalizeSeverity(left.severity)] ?? 3;
        const rightPriority = priority[normalizeSeverity(right.severity)] ?? 3;

        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }

        return String(left.message || "").localeCompare(String(right.message || ""));
      });
    }

    function normalizeSeverity(severity) {
      return ["high", "medium", "low"].includes(severity) ? severity : "low";
    }

    function toggleFindings(button) {
      const targetId = button.getAttribute("aria-controls");
      const target = targetId ? document.getElementById(targetId) : null;
      const expanded = button.getAttribute("aria-expanded") === "true";
      const nextExpanded = !expanded;
      const label = button.querySelector(".toggle-label");

      if (!target) {
        return;
      }

      target.hidden = !nextExpanded;
      button.setAttribute("aria-expanded", String(nextExpanded));
      button.classList.toggle("is-expanded", nextExpanded);

      if (label) {
        label.textContent = nextExpanded ? button.dataset.lessLabel : button.dataset.moreLabel;
      }
    }

    function updateFixPanel() {
      const button = document.getElementById("fix-issues-button");
      const count = document.getElementById("fix-issues-count");
      const summary = document.getElementById("fix-issues-summary");
      const issueResults = currentIssueResults();
      const issueCount = issueResults.reduce((total, result) => total + ((result.findings || []).length), 0);
      const productCount = issueResults.length;

      setText("fix-issues-count", issueCount + " issue" + (issueCount === 1 ? "" : "s"));

      if (summary) {
        summary.textContent = issueCount > 0
          ? issueCount + " issue" + (issueCount === 1 ? "" : "s") + " across " + productCount + " product" + (productCount === 1 ? "" : "s") + "."
          : "Run a scan to review product issues before applying updates.";
      }

      if (count) {
        count.className = "badge " + (issueCount > 0 ? "badge-warning" : "badge-muted");
      }

      if (button && !button.dataset.wasDisabled) {
        button.disabled = issueCount === 0;
      }
    }

    function currentIssueResults() {
      return (state.currentResults || []).filter((result) => (result.findings || []).length > 0);
    }

    function currentIssueProductIds() {
      return currentIssueResults()
        .map((result) => result.product?.id || result.productId)
        .filter(Boolean);
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

      if (!message) {
        el.className = "notice notice-hidden";
        el.textContent = "";
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

    function formatApiError(payload) {
      const base = payload.error || "Request failed.";
      const graphQlErrors = payload.details && Array.isArray(payload.details.errors)
        ? payload.details.errors.map((error) => error.message).filter(Boolean)
        : [];

      if (graphQlErrors.length > 0) {
        return base + " " + graphQlErrors.join(" ");
      }

      if (Array.isArray(payload.details) && payload.details.length > 0) {
        return base + " " + payload.details.map((detail) => detail.message || detail.code).filter(Boolean).join(" ");
      }

      return base;
    }
  `;
}

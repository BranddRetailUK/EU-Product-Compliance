import { Pool } from "pg";
import { config } from "./config.js";
import { ConfigurationError, decryptSecret, encryptSecret, normalizeShop } from "./security.js";

let pool;
let initPromise;

export function databaseConfigured() {
  return Boolean(config.databaseUrl);
}

export async function ensureDatabase() {
  if (!config.databaseUrl) {
    throw new ConfigurationError("DATABASE_URL is not configured.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: sslConfig()
    });
  }

  if (!initPromise) {
    initPromise = initializeSchema();
  }

  await initPromise;
  return pool;
}

export async function getShopSession(shop) {
  const normalizedShop = normalizeShop(shop);
  const db = await ensureDatabase();
  const result = await db.query(
    `SELECT shop, offline_access_token_encrypted, scope, installed, access_mode, created_at, updated_at, last_seen_at
       FROM shop_sessions
      WHERE shop = $1
      LIMIT 1`,
    [normalizedShop]
  );

  const row = result.rows[0];

  if (!row || !row.installed) {
    return null;
  }

  let accessToken;

  try {
    accessToken = decryptSecret(row.offline_access_token_encrypted);
  } catch {
    return null;
  }

  return {
    shop: row.shop,
    accessToken,
    scope: row.scope || "",
    scopes: (row.scope || "").split(",").map((scope) => scope.trim()).filter(Boolean),
    installed: row.installed,
    accessMode: row.access_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at
  };
}

export async function upsertShopSession({ shop, accessToken, scope, accessMode = "offline" }) {
  const normalizedShop = normalizeShop(shop);

  if (!normalizedShop) {
    throw new ConfigurationError("Cannot persist session for an invalid shop.");
  }

  const db = await ensureDatabase();
  const encryptedToken = encryptSecret(accessToken);

  await db.query(
    `INSERT INTO shop_sessions (
        shop,
        offline_access_token_encrypted,
        scope,
        installed,
        access_mode,
        created_at,
        updated_at,
        last_seen_at
      )
      VALUES ($1, $2, $3, true, $4, now(), now(), now())
      ON CONFLICT (shop)
      DO UPDATE SET
        offline_access_token_encrypted = EXCLUDED.offline_access_token_encrypted,
        scope = EXCLUDED.scope,
        installed = true,
        access_mode = EXCLUDED.access_mode,
        updated_at = now(),
        last_seen_at = now()`,
    [normalizedShop, encryptedToken, scope || "", accessMode]
  );

  return getShopSession(normalizedShop);
}

export async function markShopSeen(shop) {
  const normalizedShop = normalizeShop(shop);
  const db = await ensureDatabase();

  await db.query(
    `UPDATE shop_sessions
        SET last_seen_at = now(),
            updated_at = now()
      WHERE shop = $1`,
    [normalizedShop]
  );
}

export async function markShopUninstalled(shop) {
  const normalizedShop = normalizeShop(shop);
  const db = await ensureDatabase();

  await db.query(
    `UPDATE shop_sessions
        SET installed = false,
            updated_at = now()
      WHERE shop = $1`,
    [normalizedShop]
  );
}

export async function saveScanResults(shop, results) {
  const normalizedShop = normalizeShop(shop);
  const db = await ensureDatabase();

  for (const result of results) {
    await db.query(
      `INSERT INTO product_scan_results (
          shop,
          product_id,
          product_title,
          product_handle,
          readiness_status,
          readiness_score,
          findings,
          product_snapshot,
          scanned_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, now())
        ON CONFLICT (shop, product_id)
        DO UPDATE SET
          product_title = EXCLUDED.product_title,
          product_handle = EXCLUDED.product_handle,
          readiness_status = EXCLUDED.readiness_status,
          readiness_score = EXCLUDED.readiness_score,
          findings = EXCLUDED.findings,
          product_snapshot = EXCLUDED.product_snapshot,
          scanned_at = now()`,
      [
        normalizedShop,
        result.product.id,
        result.product.title,
        result.product.handle,
        result.status,
        result.score,
        JSON.stringify(result.findings),
        JSON.stringify(result.product)
      ]
    );
  }
}

export async function getScanSummary(shop) {
  const normalizedShop = normalizeShop(shop);
  const db = await ensureDatabase();
  const result = await db.query(
    `SELECT
        count(*)::int AS scanned_products,
        count(*) FILTER (WHERE readiness_status = 'ready')::int AS ready_products,
        count(*) FILTER (WHERE readiness_status = 'needs_attention')::int AS needs_attention_products,
        count(*) FILTER (WHERE readiness_status = 'blocked')::int AS blocked_products,
        max(scanned_at) AS last_scan_at
       FROM product_scan_results
      WHERE shop = $1`,
    [normalizedShop]
  );

  return result.rows[0] || emptySummary();
}

export async function listScanResults(shop, limit = 25) {
  const normalizedShop = normalizeShop(shop);
  const db = await ensureDatabase();
  const result = await db.query(
    `SELECT product_id, product_title, product_handle, readiness_status, readiness_score, findings, product_snapshot, scanned_at
       FROM product_scan_results
      WHERE shop = $1
      ORDER BY scanned_at DESC
      LIMIT $2`,
    [normalizedShop, Math.min(Math.max(Number(limit) || 25, 1), 100)]
  );

  return result.rows.map((row) => ({
    productId: row.product_id,
    title: row.product_title,
    handle: row.product_handle,
    status: row.readiness_status,
    score: row.readiness_score,
    findings: row.findings || [],
    image: row.product_snapshot?.image || null,
    scannedAt: row.scanned_at
  }));
}

function emptySummary() {
  return {
    scanned_products: 0,
    ready_products: 0,
    needs_attention_products: 0,
    blocked_products: 0,
    last_scan_at: null
  };
}

async function initializeSchema() {
  const db = pool;

  await db.query(`
    CREATE TABLE IF NOT EXISTS shop_sessions (
      shop text PRIMARY KEY,
      offline_access_token_encrypted text NOT NULL,
      scope text NOT NULL DEFAULT '',
      installed boolean NOT NULL DEFAULT true,
      access_mode text NOT NULL DEFAULT 'offline',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS product_scan_results (
      id bigserial PRIMARY KEY,
      shop text NOT NULL REFERENCES shop_sessions(shop) ON DELETE CASCADE,
      product_id text NOT NULL,
      product_title text NOT NULL DEFAULT '',
      product_handle text NOT NULL DEFAULT '',
      readiness_status text NOT NULL,
      readiness_score integer NOT NULL,
      findings jsonb NOT NULL DEFAULT '[]'::jsonb,
      product_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      scanned_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (shop, product_id)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS product_scan_results_shop_scanned_at_idx
      ON product_scan_results (shop, scanned_at DESC)
  `);
}

function sslConfig() {
  if (process.env.PGSSLMODE === "require" || config.databaseUrl.includes("sslmode=require")) {
    return {
      rejectUnauthorized: false
    };
  }

  return undefined;
}

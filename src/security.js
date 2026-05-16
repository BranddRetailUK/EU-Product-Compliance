import crypto from "node:crypto";
import { config } from "./config.js";

export class AuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.name = "AuthError";
    this.statusCode = statusCode;
  }
}

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
    this.statusCode = 503;
  }
}

export function normalizeShop(value) {
  const shop = String(value || "").trim().toLowerCase();

  if (!shop) {
    return "";
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    return "";
  }

  return shop;
}

export function verifyShopifySessionToken(token) {
  if (!config.apiKey || !config.apiSecret) {
    throw new ConfigurationError("Shopify API credentials are not configured.");
  }

  const parts = String(token || "").split(".");

  if (parts.length !== 3) {
    throw new AuthError("Invalid session token format.");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonPart(encodedHeader);
  const payload = decodeJsonPart(encodedPayload);

  if (header.alg !== "HS256") {
    throw new AuthError("Unsupported session token algorithm.");
  }

  const expectedSignature = crypto
    .createHmac("sha256", config.apiSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const actualSignature = base64UrlDecode(encodedSignature);

  if (
    expectedSignature.length !== actualSignature.length ||
    !crypto.timingSafeEqual(expectedSignature, actualSignature)
  ) {
    throw new AuthError("Invalid session token signature.");
  }

  const now = Math.floor(Date.now() / 1000);
  const toleranceSeconds = 5;

  if (typeof payload.exp !== "number" || payload.exp < now - toleranceSeconds) {
    throw new AuthError("Session token has expired.");
  }

  if (typeof payload.nbf !== "number" || payload.nbf > now + toleranceSeconds) {
    throw new AuthError("Session token is not active yet.");
  }

  if (payload.aud !== config.apiKey) {
    throw new AuthError("Session token audience does not match this app.");
  }

  const destShop = shopFromUrl(payload.dest);
  const issuerShop = shopFromUrl(payload.iss);

  if (!destShop || !issuerShop || destShop !== issuerShop) {
    throw new AuthError("Session token shop context is invalid.");
  }

  if (!payload.sub || !payload.sid) {
    throw new AuthError("Session token is missing user session fields.");
  }

  return {
    shop: destShop,
    payload
  };
}

export function getBearerToken(req) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function verifyWebhookHmac(rawBody, hmacHeader) {
  if (!config.apiSecret) {
    throw new ConfigurationError("Shopify API secret is not configured.");
  }

  if (!hmacHeader) {
    return false;
  }

  const expected = crypto.createHmac("sha256", config.apiSecret).update(rawBody).digest("base64");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(hmacHeader, "utf8");

  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

export function encryptSecret(value) {
  if (!config.sessionSecret) {
    throw new ConfigurationError("SESSION_SECRET is required to encrypt shop access tokens.");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(":");
}

export function decryptSecret(value) {
  if (!config.sessionSecret) {
    throw new ConfigurationError("SESSION_SECRET is required to decrypt shop access tokens.");
  }

  const [version, iv, tag, encrypted] = String(value || "").split(":");

  if (version !== "v1" || !iv || !tag || !encrypted) {
    throw new ConfigurationError("Stored shop access token format is not supported.");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function decodeJsonPart(value) {
  try {
    return JSON.parse(base64UrlDecode(value).toString("utf8"));
  } catch {
    throw new AuthError("Invalid session token encoding.");
  }
}

function base64UrlDecode(value) {
  return Buffer.from(String(value), "base64url");
}

function shopFromUrl(value) {
  try {
    const url = new URL(String(value));
    return normalizeShop(url.hostname);
  } catch {
    return "";
  }
}

function encryptionKey() {
  return crypto.scryptSync(config.sessionSecret, "eu-product-compliance:shop-token:v1", 32);
}

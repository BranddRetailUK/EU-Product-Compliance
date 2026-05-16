import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

process.env.SHOPIFY_API_KEY = "client-id-123";
process.env.SHOPIFY_API_SECRET = "shared-secret-123";

const { verifyShopifySessionToken } = await import("../src/security.js");

test("verifies a valid Shopify HS256 session token", () => {
  const token = signSessionToken({
    aud: "client-id-123",
    dest: "https://test-shop.myshopify.com",
    exp: Math.floor(Date.now() / 1000) + 60,
    iat: Math.floor(Date.now() / 1000),
    iss: "https://test-shop.myshopify.com/admin",
    jti: "test-jti",
    nbf: Math.floor(Date.now() / 1000) - 1,
    sid: "test-session-id",
    sub: "1234"
  });

  const result = verifyShopifySessionToken(token);

  assert.equal(result.shop, "test-shop.myshopify.com");
  assert.equal(result.payload.aud, "client-id-123");
});

test("rejects a session token signed with the wrong secret", () => {
  const token = signSessionToken(
    {
      aud: "client-id-123",
      dest: "https://test-shop.myshopify.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "https://test-shop.myshopify.com/admin",
      nbf: Math.floor(Date.now() / 1000) - 1,
      sid: "test-session-id",
      sub: "1234"
    },
    "wrong-secret"
  );

  assert.throws(() => verifyShopifySessionToken(token), /signature/i);
});

function signSessionToken(payload, secret = "shared-secret-123") {
  const header = {
    alg: "HS256",
    typ: "JWT"
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

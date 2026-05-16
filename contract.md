# Contract

This file is the source of truth for the app and repository behavior that currently exists. It is not a roadmap, planning document, or production change log. Keep it updated to describe the present implementation only.

## Project Context

The repository is for a Shopify app currently intended to become an EU Product Compliance + Customs Readiness Scanner. The app deploys as a Node.js HTTP service with an embedded Shopify admin App Home, backend Shopify session-token authentication, token exchange, Postgres-backed shop sessions, product reads/writes through the Shopify Admin GraphQL API, scanner rules, and optional AI-assisted review.

## Implemented Application Functionality

The application currently implements an HTTP server in `src/server.js`.

- `GET /`: Returns the Shopify App Home overview surface. It includes Shopify App Bridge and Polaris CDN scripts, configures the App Bridge API key from `SHOPIFY_API_KEY`, and renders merchant-facing readiness metrics plus recent product reviews.
- `GET /products`: Returns the embedded products surface. It reads product data through authenticated backend API routes, displays scanner readiness, supports Shopify's resource picker, and can trigger product scans with a modal scan overlay using eased circular progress and a lightened leading edge.
- `GET /settings`: Returns the embedded settings surface showing merchant-facing scan coverage and whether AI review is enabled.
- `GET /health`: Returns JSON health status for hosting checks.
- `GET /auth`: Validates the `shop` query parameter and redirects valid shops to their Shopify admin apps area. It does not perform OAuth.
- `GET /auth/callback`: Returns a `501` JSON response because authorization-code callback handling has not been implemented. The current app surface expects Shopify managed installation.
- `GET /api/session`: Requires a Shopify App Bridge session token, verifies the token, performs token exchange when needed, stores the shop offline Admin API token encrypted in Postgres, and returns session, AI availability, and scanner summary data.
- `GET /api/products`: Requires a verified session token and stored shop session, reads products from Shopify Admin GraphQL, and returns products with computed readiness results.
- `GET /api/scans`: Requires a verified session token and returns saved scanner results from Postgres.
- `POST /api/scan-products`: Requires a verified session token, reads selected or recent products from Shopify, applies scanner rules, optionally adds AI-assisted advisory recommendations, writes compliance metafields back to Shopify products, and stores scan results in Postgres.
- `POST /webhooks/app/uninstalled`: Verifies the Shopify webhook HMAC and marks the shop session as uninstalled in Postgres.
- All other routes return a `404` JSON response.

The HTTP runtime sets a Content Security Policy that permits embedding in Shopify admin and `*.myshopify.com` frames. App Bridge session tokens are verified with HS256 using `SHOPIFY_API_SECRET`; token claims are checked for signature, expiry, activation time, audience, shop destination, issuer, subject, and session ID.

The app uses Shopify token exchange to obtain an offline Admin API token for each installed shop. Offline tokens are encrypted with `SESSION_SECRET` before storage.

Scanner rules currently inspect products and shipping-required variants for:

- Missing vendor.
- Missing product type.
- No shipping-required variants.
- Missing variant SKU.
- Missing variant HS code.
- Missing variant country of origin.
- Missing variant barcode.

When `OPENAI_API_KEY` is configured, product scans also send compact product and findings data to the OpenAI Responses API using structured JSON output. AI output is treated as advisory: it can append AI-sourced recommendations to findings and add an `aiReview` object to API responses, but the deterministic readiness status and score are still calculated by local scanner rules.

Scanner results produce a readiness status of `ready`, `needs_attention`, or `blocked`, plus a numeric score. Product scan writes use product metafields under the `eu_product_compliance` namespace:

- `readiness_status`
- `readiness_score`
- `last_scan_at`
- `findings_json`

There are currently no background jobs or Shopify extensions implemented.

## Repository Files

- `contract.md`: Documents the current implemented behavior and repository state.
- `AGENTS.md`: Instructs future coding agents to read and maintain this contract.
- `.env.example`: Tracked environment variable template for the planned Shopify app, including the current planned Shopify API scopes.
- `.env`: Local ignored environment configuration for the planned Shopify app. It is not intended to be committed.
- `.gitignore`: Ignores local secrets, dependency folders, build outputs, logs, and generated Shopify/runtime artifacts.
- `package.json`: Defines the Node.js runtime metadata and `start`/`check` scripts.
- `package-lock.json`: npm lockfile for the Node.js package.
- `src/config.js`: Central environment configuration.
- `src/database.js`: Postgres schema initialization, encrypted shop session storage, uninstall marking, and scanner result persistence.
- `src/scanner.js`: Product compliance/customs readiness scanner rules.
- `src/ai.js`: Optional OpenAI Responses API integration for advisory customs readiness recommendations.
- `src/security.js`: Shopify session-token verification, webhook HMAC verification, shop-domain validation, and access-token encryption helpers.
- `src/shopify.js`: Shopify token exchange, Admin GraphQL product reads, and compliance metafield writes.
- `src/server.js`: Built-in Node HTTP server, App Home renderer, API routes, and webhook route.
- `test/ai.test.js`: AI enhancement fallback tests.
- `test/scanner.test.js`: Scanner behavior tests.
- `test/security.test.js`: Session-token verification tests.

## Configuration Surface

The repository provides `.env.example` as a safe template for local `.env` configuration.

The environment configuration surface currently includes placeholders for:

- Shopify OAuth/Admin API configuration.
- Shopify API scopes.
- Local app URL and server settings.
- Database connection.
- Session/security secret.
- Optional AI-assisted classification and model selection.
- Optional managed billing plan identifiers.

The current HTTP runtime reads:

- `PORT`: Chooses the listening port.
- `SHOPIFY_API_KEY`: Populates the App Bridge API key meta tag.
- `SHOPIFY_API_SECRET`: Verifies Shopify session tokens, performs token exchange, and verifies Shopify webhook HMACs.
- `SHOPIFY_API_VERSION`: Selects the Shopify Admin API version used for GraphQL calls.
- `SCOPES`: Defines the Admin API scopes expected on stored Shopify sessions.
- `DATABASE_URL`: Connects to Postgres for shop sessions and scanner results.
- `PGSSLMODE`: When set to `require`, enables Postgres SSL with relaxed certificate verification for managed hosting.
- `SESSION_SECRET`: Encrypts stored Shopify offline access tokens.
- `OPENAI_API_KEY`: Enables optional server-side AI review during product scans.
- `OPENAI_MODEL`: Selects the OpenAI model for optional AI review and defaults to `gpt-4o-mini`.

The app still defines placeholders for optional Shopify managed billing plan identifiers, but no runtime code consumes those billing values yet.

## Database Schema

The app initializes these Postgres tables on demand:

- `shop_sessions`: Stores one row per shop, encrypted offline Admin API token, granted scopes, install status, access mode, and timestamps.
- `product_scan_results`: Stores latest scanner result per shop/product pair, including status, score, findings JSON, product snapshot JSON, and scan timestamp.

## Runtime And Dependencies

The runtime is a Node.js application using built-in `node:http` plus the `pg` package for Postgres access.

- `npm start`: Starts `src/server.js`.
- `npm run check`: Runs syntax validation for all source modules and executes the Node test suite.
- `npm run check:syntax`: Runs Node syntax validation for all source modules.
- `npm test`: Runs the Node test suite.

No build step, bundler, TypeScript configuration, or background worker exists yet.

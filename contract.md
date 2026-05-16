# Contract

This file is the source of truth for the app and repository behavior that currently exists. It is not a roadmap, planning document, or production change log. Keep it updated to describe the present implementation only.

## Project Context

The repository is for a Shopify app currently intended to become an EU Product Compliance + Customs Readiness Scanner. A minimal Node.js HTTP runtime exists so the service can deploy and expose an embedded Shopify admin app surface while the scanner implementation is still pending.

## Implemented Application Functionality

The application currently implements a minimal HTTP server in `src/server.js`.

- `GET /`: Returns the Shopify App Home overview surface. It includes Shopify App Bridge and Polaris CDN scripts, configures the App Bridge API key from `SHOPIFY_API_KEY`, and renders an admin-style dashboard for installed-store context.
- `GET /products`: Returns the embedded products surface. It includes a product-picker action that works when the page is opened inside Shopify admin.
- `GET /settings`: Returns the embedded settings surface showing current public URL, API version, configured scopes, and store context.
- `GET /health`: Returns JSON health status for hosting checks.
- `GET /auth`: Validates the `shop` query parameter and redirects valid shops to their Shopify admin apps area. It does not perform OAuth.
- `GET /auth/callback`: Returns a `501` JSON response because authorization-code callback handling has not been implemented. The current app surface expects Shopify managed installation.
- All other routes return a `404` JSON response.

The HTTP runtime sets a Content Security Policy that permits embedding in Shopify admin and `*.myshopify.com` frames. There are currently no backend Shopify API integrations, OAuth/session-token validation, token exchange flows, database models, background jobs, webhooks, Shopify extensions, scanners, or compliance business rules implemented in this repository.

## Repository Files

- `contract.md`: Documents the current implemented behavior and repository state.
- `AGENTS.md`: Instructs future coding agents to read and maintain this contract.
- `.env.example`: Tracked environment variable template for the planned Shopify app, including the current planned Shopify API scopes.
- `.env`: Local ignored environment configuration for the planned Shopify app. It is not intended to be committed.
- `.gitignore`: Ignores local secrets, dependency folders, build outputs, logs, and generated Shopify/runtime artifacts.
- `package.json`: Defines the Node.js runtime metadata and `start`/`check` scripts.
- `package-lock.json`: npm lockfile for the dependency-free Node.js package.
- `src/server.js`: Minimal built-in Node HTTP server used by the deployed service.

## Configuration Surface

The repository provides `.env.example` as a safe template for local `.env` configuration.

The environment configuration surface currently includes placeholders for:

- Shopify OAuth/Admin API configuration.
- Shopify API scopes.
- Local app URL and server settings.
- Database connection.
- Session/security secret.
- Optional AI-assisted classification.
- Optional managed billing plan identifiers.

The current HTTP runtime reads:

- `PORT`: Chooses the listening port.
- `APP_URL` or `SHOPIFY_APP_URL`: Displays the configured public URL in the app surface.
- `SHOPIFY_API_KEY`: Populates the App Bridge API key meta tag.
- `SHOPIFY_API_VERSION`: Displays the configured Admin API version.
- `SCOPES`: Displays the configured Admin API scopes.

## Runtime And Dependencies

The runtime is a dependency-free Node.js application using built-in `node:http`.

- `npm start`: Starts `src/server.js`.
- `npm run check`: Runs Node syntax validation for `src/server.js`.

No installed third-party dependencies, test runner, database schema, or build configuration exists yet.

# Contract

This file is the source of truth for the app and repository behavior that currently exists. It is not a roadmap, planning document, or production change log. Keep it updated to describe the present implementation only.

## Project Context

The repository is for a Shopify app currently intended to become an EU Product Compliance + Customs Readiness Scanner. No Shopify application runtime has been scaffolded yet.

## Implemented Application Functionality

None. There are currently no app routes, UI surfaces, API integrations, database models, background jobs, webhooks, Shopify extensions, scanners, or business rules implemented in this repository.

## Repository Files

- `contract.md`: Documents the current implemented behavior and repository state.
- `AGENTS.md`: Instructs future coding agents to read and maintain this contract.
- `.env.example`: Tracked environment variable template for the planned Shopify app, including the current planned Shopify API scopes.
- `.env`: Local ignored environment configuration for the planned Shopify app. It is not intended to be committed.
- `.gitignore`: Ignores local secrets, dependency folders, build outputs, logs, and generated Shopify/runtime artifacts.

## Configuration Surface

The repository provides `.env.example` as a safe template for local `.env` configuration. These variables are placeholders only. No runtime code consumes them yet.

The environment configuration surface currently includes placeholders for:

- Shopify OAuth/Admin API configuration.
- Shopify API scopes.
- Local app URL and server settings.
- Database connection.
- Session/security secret.
- Optional AI-assisted classification.
- Optional managed billing plan identifiers.

## Runtime And Dependencies

No package manifest, lockfile, installed dependencies, server entrypoint, test runner, database schema, or build configuration exists yet.

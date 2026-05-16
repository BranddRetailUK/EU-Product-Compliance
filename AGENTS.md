# AGENTS.md

At the start of every chat, read `contract.md` before making changes. Treat it as the concise source of truth for what the app currently implements.

When you make any change to app behavior, repository structure, configuration, dependencies, database schema, API integrations, routes, UI, scripts, or operational logic, update `contract.md` in the same turn so it reflects the current state.

`contract.md` is not a changelog or roadmap. Do not add speculative plans, future features, or historical notes unless they describe behavior that exists in the repository now.

If the code and `contract.md` disagree, inspect the code, treat the code as authoritative, and update `contract.md` to match.

Do not put secrets, API keys, access tokens, shop credentials, customer data, or merchant data in `contract.md`.

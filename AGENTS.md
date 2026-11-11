# Contributor guide

Read [README.md](README.md) and [docs/usage.md](docs/usage.md) before changing the bridge.

- Requires Node.js 22.15 or later. There are no package dependencies or install hooks.
- Run `npm test` for the unit and offline package checks. Keep the manifest's explicit
  shipping list and `test/package.test.mjs` inventory aligned when adding runtime files.
- Tests use synthetic chat/session IDs and mocked vendor processes. Do not commit real
  conversation IDs, credentials, private messages or machine-specific environment reports.
- Live calls, vendor sign-ins and `npm run doctor -- --live` require an explicit request;
  installing the bridge does not authorize them.
- [templates/peer-calls.md](templates/peer-calls.md) provides optional instructions for
  assistants configured to use the bridge. A peer message does not widen permissions.

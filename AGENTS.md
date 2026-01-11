# Repository Guidelines

## Project Structure & Module Organization
`proxy.mjs` is the main HTTP proxy that converts Anthropic requests to Ollama chat completions. Supporting modules live in `src/` (queueing, security helpers, MCP pipeline tools, and shared types). MCP exposure is handled by `opencode-mcp-server.mjs`. Tests live in `test/` (Node’s built-in test runner). `mac-control-hub/` is a separate optional service for remote Mac control; keep its changes scoped and consult `mac-control-hub/README.md` when editing.

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `npm run start` starts the proxy at `http://127.0.0.1:8787`.
- `npm run start:mcp` starts the MCP server defined in `opencode-mcp-server.mjs`.
- `npm run mcp-pipeline` runs the pipeline MCP server (note: the script currently points to `src/server.ts`; update if you switch to `src/server.js`).
- `npm test` runs the Node test runner (`node --test`).

## Coding Style & Naming Conventions
The repo uses ESM (`"type": "module"`), so prefer `import`/`export` and `.mjs` for entrypoints. Use 2-space indentation, semicolons, and match the existing quote style in the file you touch (most files use double quotes). Name functions in `camelCase`, classes in `PascalCase`, and constants/env vars in `SCREAMING_SNAKE_CASE` (for example, `PROXY_BEARER`, `MAX_INFLIGHT`).

## Testing Guidelines
Tests are plain Node tests in `test/*.test.mjs` using `node:test` and `node:assert/strict`. Name new tests with descriptive strings (see `test/proxy.test.mjs`). There is no explicit coverage gate; add tests when you change request mapping, model selection, or queueing behavior.

## Commit & Pull Request Guidelines
Recent commits are short, descriptive summaries in either English or Chinese (no enforced Conventional Commits). Keep messages concise and action-oriented (for example, “Add basic tests and make proxy importable”). PRs should include a brief summary, testing notes (commands + results), and call out any env var or protocol changes; add screenshots only when a UI is affected.

## Configuration & Security Tips
Authentication is via `PROXY_BEARER` (default `local`); keep it set when exposing the proxy. MCP deployments use `OPENCODE_MCP_KEY` and optional `OPENCODE_MCP_ALLOWED_HOSTS`—document any changes to these defaults in PRs.

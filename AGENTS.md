# Agent Instructions for plebbit-js

Instructions for AI agents working on this codebase. Rules are ranked by priority: **MUST** rules are mandatory and cannot be skipped; **SHOULD** rules are strong defaults that apply in most situations.

## Task Router

| Situation | Action |
|---|---|
| Modifying `src/` | Run `npm run build`, ensure no errors |
| Modifying `test/` | Run `npx tsc --project test/tsconfig.json --noEmit` |
| Editing schema | Check local zod version in `package.json` first |
| Running tests | Use `node test/run-test-config.js --plebbit-config ${plebbit-config} ${testPath}` |
| Bug reported | Reproduce deterministically in a test case first |
| Debugging CI failures | Check `test_server.log` and `test_node_${config}.stdout.log`/`.stderr.log` artifacts |

## MUST Rules

### Build

- Run `npm run build` when modifying files inside `src/`, and make sure it passes with no errors. You don't need to run build if you're modifying files outside `src/`.
- Node-only code MUST go under `src/runtime/node/`, not directly under `src/` — otherwise the browser build will fail.
- Do not commit `/dist` to git.

### Testing

- Run every automated test suite through `node test/run-test-config.js --plebbit-config ${plebbit-config} ${testPath}` so our Vitest setup enforces bail/allowOnly/timeouts automatically. Choose plebbit-config based on test location: `test/node` → `"local-kubo-rpc,remote-plebbit-rpc"`, `test/node-and-browser` → `"remote-kubo-rpc,remote-plebbit-rpc"`.
- Test files MUST be written in TypeScript (`.test.ts`). The test runner will type-check all TypeScript test files before running them.
- Tests that use `LocalSubplebbit` or other Node-only types MUST be placed under `test/node/`, not `test/node-and-browser/`.
- Do not include `this.timeout` in tests — it is not supported by vitest.
- When you modify a test file, make sure it passes the test build process: `npx tsc --project test/tsconfig.json --noEmit`.
- You should not run `npm run test:server:node` yourself — instead ask me to do it.

### Code

- Never use `removeAllListeners` — it removes the error listener initialized in the constructor, which may cause the process to crash.
- `author.address` and `subplebbit.address` are immutable — never override or fall back to a derived address; use `author.nameResolved` to indicate whether a domain resolved correctly.
- A comment's bytes size during publication is limited to 40kb.

### Debugging

- When a bug or regression is reported, reproduce it deterministically in a test case first, then brainstorm how to fix it.
- When a bug or test failure is reported, understand the root cause instead of trying to fix it with timeouts.

## SHOULD Rules

### Schema & Database

- If you're editing schema, check for docs relevant to the local zod version by checking `package.json`.
- When adding a new JSON column to the database, add a test in `test/node/subplebbit/parsing.db.subplebbit.test.ts` for parsing it, and if it's on a comment, add an integration test for `dbHandler.queryComment` returning the proper JSON value (not a string).

### Testing Patterns

- Use vitest utilities for mocking.
- When mocking a comment, create a fixture that looks like production. For comment (`CommentIpfs`), look at `test/fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json`; for `commentUpdate`, look at `test/fixtures/signatures/comment/commentUpdate/valid_comment_update.json`.
- Prefer `createSubplebbit()` + `update()` over `getSubplebbit()`, since `getSubplebbit` does a one-shot fetch that fails randomly in CI.
- When creating a Plebbit instance pointing at local test Kubo (`http://localhost:15001/api/v0`), always pass `httpRoutersOptions: []` to prevent the Zod default from adding production routers, which triggers a Kubo shutdown/restart and breaks parallel tests with ECONNREFUSED.
- When running RPC tests (e.g. `remove.test.js`), set `USE_RPC=1` in the environment.
- If RPC tests are failing, consider the RPC server may be outdated and carrying old `dist/`.

### Code Patterns

- When writing new functions, prefer a single object parameter with all args (e.g., `signComment({ comment, plebbit })` instead of `signComment(comment, plebbit)`).
- Use `npx ipfs` not the system-wide `ipfs` binary.

### Debugging Patterns

- When debugging CI failures, check `test_server.log` for subplebbit logs and `test_node_${config}.stdout.log`/`test_node_${config}.stderr.log` artifacts for client logs (where config is e.g. `remote-kubo-rpc`).
- To troubleshoot or debug anything related to a local subplebbit, run sqlite queries against its database at `${plebbitDataPath}/subplebbits/${subplebbitAddress}`.

## Domain Notes

- Each HTTP router keeps provider announcements for only 24 hours.

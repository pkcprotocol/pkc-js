# Agent Instructions for pkc-js

Instructions for AI agents working on this codebase. Rules are ranked by priority: **MUST** rules are mandatory and cannot be skipped; **SHOULD** rules are strong defaults that apply in most situations.

## Task Router

| Situation | Action |
|---|---|
| Modifying `src/` | Run `npm run build`, ensure no errors |
| Modifying `test/` | Run `npx tsc --project test/tsconfig.json --noEmit` |
| Running tests | Use `node test/run-test-config.js --pkc-config ${pkc-config} ${testPath}` |
| Bug reported | Reproduce deterministically in a test case first |
| Debugging CI failures | Download the `per-test-logs-*` and `test-server-log-*` artifacts from the failed run; check per-test stderr logs first, then `test_server.log` for community-side errors |
| CI hang/timeout that looks like Kubo (MFS `Timed out writing/removing MFS path`, `UND_ERR_HEADERS_TIMEOUT`, `ERR_TIMED_OUT_RM_MFS_FILE`) | Download the `kubo-logs-node-local-*` artifact: it has each daemon's `kubo_*_golog_*.log` (Go debug log) and the `kubo-debug/goroutine-*.txt` pprof dumps captured on failure. Grep the dumps for `boxo/mfs`/`Flush`/`Lock` to see where MFS is blocked — client-side `pkc-js` logs only show the timeout, not the daemon-side cause. Since kubo 0.43.0 an MFS timeout is normally *contention*, not a wedge: `repo gc` and in-flight MFS writes hold each other off, and a stuck write now errors instead of hanging forever. A genuinely wedged daemon (the old ipfs/kubo#10842 signature) should no longer occur — if one does, that is an upstream regression worth reporting |

## Protocol Context

Before working on certain areas, read the relevant protocol doc to avoid mistakes.

| Working on | Read first |
|---|---|
| Comment publishing, CommentIpfs, CommentUpdate | `docs/protocol/comment-lifecycle.md` |
| Author/community wire format, `publication-author.ts`, `community-wire.ts` | `docs/protocol/wire-vs-runtime.md` |
| Addresses, domains, `.bso`, `.eth`, `nameResolvers`, `nameResolved` | `docs/protocol/names-and-addresses.md` |
| `src/community/`, RemoteCommunity, LocalCommunity, RPC variants | `docs/protocol/community-architecture.md` |
| `src/signer/signatures.ts`, verification, `signedPropertyNames` | `docs/protocol/signing.md` |
| `src/pages/`, pagination, sort types, `pageCids` | `docs/protocol/pages.md` |
| `comment.crosspost`, embedded records, `features.noCrossposts` | `docs/protocol/crossposts.md` |
| Challenge/response, `src/pubsub-messages/`, encryption | `docs/protocol/challenge-flow.md` |
| `settings.challenges`, challenge options, sensitive config | `docs/protocol/challenge-settings.md` |
| Writing a challenge package, `optionInputs`, `validateChallengeSettings` | `docs/protocol/challenge-authoring.md` |
| Data storage, IPFS CIDs, IPNS, mutability questions | `docs/protocol/data-permanence.md` |
| DB migration, `extraProps`, CID reconstruction, `deriveCommentIpfsFromCommentTableRow` | `docs/protocol/db-community-address-migration.md` |
| Gateway fetching, `_fetchWithGateway`, `ETag`/`If-None-Match`, `Cache-Control`/`max-age`, gateway polling | The IPFS path-gateway spec: <https://specs.ipfs.tech/http-gateways/path-gateway/> (ETag/304 semantics, `max-age` = remaining IPNS record TTL, HEAD and `only-if-cached` probes, `?format=ipns-record`) |

## MUST Rules

### Build

- Run `npm run build` when modifying files inside `src/`, and make sure it passes with no errors. You don't need to run build if you're modifying files outside `src/`.
- Node-only code MUST go under `src/runtime/node/`, not directly under `src/` — otherwise the browser build will fail.
- Do not commit `/dist` to git.
- Do not write temporary files (logs, test output) to `/tmp` — it is RAM-backed (`tmpfs`) on Linux and wastes memory. Use `.tmp/` in the project root instead (it is gitignored and cleaned up by the test server on startup).

### Testing

- Run every automated test suite through `node test/run-test-config.js --pkc-config ${pkc-config} ${testPath}` so our Vitest setup enforces bail/allowOnly/timeouts automatically. Choose pkc-config based on test location: `test/node` → `"local-kubo-rpc,remote-pkc-rpc"`, `test/node-and-browser` → `"remote-kubo-rpc,remote-pkc-rpc"`.
- Test files MUST be written in TypeScript (`.test.ts`). The test runner will type-check all TypeScript test files before running them.
- Tests that use `LocalCommunity` or other Node-only types MUST be placed under `test/node/`, not `test/node-and-browser/`.
- Do not include `this.timeout` in tests — it is not supported by vitest.
- When you modify a test file, make sure it passes the test build process: `npx tsc --project test/tsconfig.json --noEmit`.
- When you modify a function in `test/test-util.ts`, search all test files under `test/` that import or call that function (e.g. `grep -r "functionName" test/`), then run those tests and make sure they pass.
- You should still run tests without waiting for me and assume the test server is running by me. You should not run run test server `npm run test:server:node` yourself — instead ask me to do it or assume I'm doing it. Test server is not the same as test files, but many test files need test server running.
- When bumping `DB_VERSION`, add a migration test that creates an in-memory DB with the old schema, inserts representative rows, runs migration via `createOrMigrateTablesIfNeeded()`, and asserts the migrated data is correct. Focus on tables whose schema changed.
- When using `describeSkipIfRpc`, `itSkipIfRpc`, or otherwise skipping tests for RPC, you MUST add a comment above explaining why the test cannot run under RPC.

### Code

- Never use `removeAllListeners` — it removes the error listener initialized in the constructor, which may cause the process to crash.
- `author.address` and `community.address` are immutable — never override or fall back to a derived address; use `author.nameResolved` to indicate whether a domain resolved correctly.
- Every time you add a runtime-only field, ask whether it should also be added to the corresponding reserved-field list before you finish the change.
- A comment's bytes size during publication is limited to 40kb.
- An author and a community cannot share the same domain name for now.
- Never use the `any` type or cast to `any` without consulting the user first — this repo should remain fully typed.

### Debugging

- When a failing test is reported, run it first with stdout and stderr captured (e.g. `--per-test-logs .tmp/test-logs`, `--stdout-log .tmp/out.log --stderr-log .tmp/err.log`, or `DEBUG="pkc-js*"`) and derive your theory from the logs. Do not start by reading source code — the codebase has many moving parts and logs give a far more reliable picture of what actually went wrong.
- When a bug or regression is reported, reproduce it deterministically in a test case first, then brainstorm how to fix it.
- When a bug or test failure is reported, understand the root cause instead of trying to fix it with timeouts.

### Workflow

- When given a prompt to implement a feature, create a GitHub issue for it using `gh issue create`. Keep the issue body up to date with your implementation plan and progress as work proceeds. Once the feature is fully implemented, close the issue with `gh issue close`.
- Never include identifying information in GitHub issues, PR descriptions, or commit messages. This includes absolute home-directory paths (e.g. `/home/<username>/...`), usernames, machine hostnames, personal email addresses, or other local-machine details. Use repo-relative paths and generic placeholders instead.
- PR titles and commit subjects MUST pass commitlint (`@commitlint/config-conventional`): `type(scope): subject`, and **at most 100 characters total**, including the `type(scope): ` prefix. The `lint-pr-title` CI job runs commitlint on the PR title, so an over-long title fails CI even when every test passes. Before creating or renaming a PR, verify the title locally:

  ```bash
  printf '%s\n' "$TITLE" | npx commitlint --config commitlint.config.cjs
  ```

  If the subject does not fit, shorten it — do not split it with `;` or move detail into the title. Put the detail in the PR body.
- The PR title type MUST NOT hide releasable commits. PRs are squash-merged, so the title becomes the only commit message release-it sees; a PR titled `chore:`/`docs:`/`test:` that contains a `fix`/`feat`/`perf`/`build`/`revert` commit ships a release with empty notes, and the `lint-pr-title` CI job (`.github/workflows/check-pr-title-type.cjs`) fails. This most often happens when a PR is opened as `chore:` and a `fix:` commit is pushed later. Before creating a PR and again before every push to an open PR, run the same check locally:

  ```bash
  npm run check:pr-title -- --title "$TITLE"
  ```

  If it fails, retitle the PR with the type of its user-visible effect (`gh pr edit <n> --title "$TITLE"`) rather than retyping the commits.

## SHOULD Rules

### Schema & Database

- If you're editing schema, check for docs relevant to the local zod version by checking `package.json`.
- When modifying a schema (e.g. adding, removing, or renaming fields), check if `README.md` references that schema and update it accordingly.
- When adding a new JSON column to the database, add a test in `test/node/community/parsing.db.community.test.ts` for parsing it, and if it's on a comment, add an integration test for `dbHandler.queryComment` returning the proper JSON value (not a string).
- When adding a new markdown file under `docs/`, add a corresponding entry to `docs/protocol/README.md` (the protocol docs index table).

### Testing Patterns

- Use vitest utilities for mocking.
- When mocking a comment, create a fixture that looks like production. For comment (`CommentIpfs`), look at `test/fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json`; for `commentUpdate`, look at `test/fixtures/signatures/comment/commentUpdate/valid_comment_update.json`.
- Prefer `createCommunity()` + `update()` over `getCommunity()`, since `getCommunity` does a one-shot fetch that fails randomly in CI.
- When creating a PKC instance pointing at local test Kubo (`http://localhost:15001/api/v0`), always pass `httpRoutersOptions: []` to prevent the Zod default from adding production routers, which triggers a Kubo shutdown/restart and breaks parallel tests with ECONNREFUSED.
- When running RPC tests (e.g. `remove.test.js`), set `USE_RPC=1` in the environment.
- If RPC tests are failing, consider the RPC server may be outdated and carrying old `dist/`.
- When writing tests related to loading (e.g., loading a comment, community, or page), prefer generating a fixture to test against instead of relying on a live community.
- Exact-state assertions (a full-array `deep.equal` on states recorded from `statechange`/`updatingstatechange`, or sampling a state at a point in time) MUST NOT attach to a shared live community such as `signers[0]` or `plebbit.bso`. Every concurrent suite publishes there, and the update loop is arrival-driven, so each publish starts a fetch cycle at a random moment and inserts states mid-assertion. Use `publishStaticCommunityWithPostInPages()` (a fresh key published exactly once; `withReplyInPostPages` for a reply in the post's preloaded replies page, `withSelfResolvingName` for a domain name the mock resolver maps back to the key, including through the RPC server) or another static fixture instead. The static fixture removes arrival-driven cycles only: the loop also re-runs on a timer (libp2p-js safety net at `updateInterval * (0.75..1.25)`, gateway poll at `updateInterval`), so a test that asserts states across a comment's CommentUpdate fetch must also attach through a PKC created with `updateInterval: updateIntervalForExactStateTests` so that timer cannot fire inside the assertion window. See issue #323.

### Code Patterns

- When writing new functions, prefer a single object parameter with all args (e.g., `signComment({ comment, pkc })` instead of `signComment(comment, pkc)`).
- Use `npx ipfs` not the system-wide `ipfs` binary.

### Debugging Patterns

- When debugging locally, the test server automatically logs combined stdout+stderr to `.tmp/test-server-{config}-{date}.log` (e.g. `.tmp/test-server-local-kubo-rpc-2026-04-15T12-00-00.log`). Check there first for test server errors.
- When debugging CI failures, download the GitHub Actions artifacts from the failed run. The most useful are: (1) `per-test-logs-*` — contains per-test-file `<stem>.stdout.log` and `<stem>.stderr.log` mirroring the test path (e.g. `node/pkc/pkc.stderr.log`); start with the stderr log of the failing test file. (2) `test-server-log-*` — the full `test_server.log` with community-side DEBUG output. (3) `test-logs-*` — aggregate stdout/stderr from `--log-prefix`. (4) `vitest-*` — vitest JSON reports. (5) `kubo-logs-node-local-*` — the Kubo daemons' own `kubo_*_golog_*.log` (Go debug logs) plus `kubo-debug/goroutine-*.txt` pprof dumps captured on failure; use these when a CI timeout looks like a Kubo/MFS hang (see the Task Router row), since the `pkc-js` logs only show the client-side timeout, not the daemon-side cause.
- To capture stdout/stderr from `run-test-config.js` to log files, use `--stdout-log <path>` and `--stderr-log <path>`, or use `--log-prefix <prefix>` to automatically create `<prefix>.stdout.log` and `<prefix>.stderr.log`. DEBUG output (from the `debug` module) goes to stderr.
- To capture per-test-file logs, use `--per-test-logs <dir>`. Each test file gets its own `<stem>.stdout.log` and `<stem>.stderr.log` under a directory structure mirroring the test path (e.g. `test/node/pkc/pkc.test.ts` → `<dir>/node/pkc/pkc.stderr.log`). This also captures DEBUG output by redirecting the `debug` module through `console.error`, which vitest then captures per-test via `onUserConsoleLog`. Example: `DEBUG="pkc-js*" node test/run-test-config.js --pkc-config "local-kubo-rpc,remote-pkc-rpc" --per-test-logs .tmp/test-logs test/node/pkc/pkc.test.ts`.
- For very large non-source artifacts such as CI logs, debug traces, generated JSON, or massive tool output, agents may optionally use `chopratejas/headroom` or a similar local compression tool as a navigation aid, but must verify conclusions against the original uncompressed artifact before editing code or making final claims.
- To troubleshoot or debug anything related to a local community, run sqlite queries against its database at `${dataPath}/communities/${communityAddress}`.
- When a test times out, capture both stdout and stderr (e.g. `--stdout-log .tmp/out.log --stderr-log .tmp/err.log` or `DEBUG="pkc-js*,pkc-react-hooks*"`) and inspect them — timeouts usually indicate an uncaught error that isn't surfaced in the default output.
- `FailedToFetchCommunityFromGatewaysError: Failed to fetch Community IPNS record from gateway` is a generic wrapper error — the message alone does not explain the root cause. Always inspect the error's `details` field and any nested/inner errors to find the actual failure reason.

### Workflow

- For changes under `src/` or `test/`, open a pull request rather than pushing directly to `master` so CodeRabbit can review. Direct push to `master` is fine for docs, config tweaks, `AGENTS.md`/`CLAUDE.md` edits, and hotfixes.

## Domain Notes

- Each HTTP router keeps provider announcements for only 24 hours.

# Contributing to pkc-js

pkc-js is the TypeScript SDK for PKC (Public Key Communities), a serverless social protocol built on IPFS, IPNS and libp2p pubsub. It runs in Node and in browsers, and [bitsocial-cli](https://github.com/bitsocialnet/bitsocial-cli), [bitsocial-react-hooks](https://github.com/bitsocialnet/bitsocial-react-hooks) and the clients built on them depend on it. Every successful CI run on `master` publishes a new version to npm, so `master` must stay releasable.

Before you start, read:

- [docs/testing.md](docs/testing.md) for setup, the test server and running tests, and [docs/building.md](docs/building.md) for how the Node and browser builds are produced.
- [AGENTS.md](AGENTS.md). Its Build, Testing and Code rules describe constraints of this codebase and apply to human contributors too; the rest covers coding-agent workflow.
- The [protocol docs index](docs/protocol/README.md). Read the doc for the area you are changing first; AGENTS.md maps source paths to docs.
- [docs/versioning.md](docs/versioning.md) for how releases are cut and how to mark a breaking change.

## Where to help

The [issue tracker](https://github.com/pkcprotocol/pkc-js/issues) is the backlog. For anything larger than a small fix, comment on the issue before starting so work is not duplicated, and open an issue first if none exists.

## Rules that most often decide a review

These come from AGENTS.md; follow the link for the full list.

- **Node-only code goes under `src/runtime/node/`.** The browser build swaps it for `src/runtime/browser/`, and anything else under `src/` must run in both environments.
- **The code stays fully typed.** Do not add `any` or cast to `any` without agreeing it with the maintainer first.
- **Fix bugs from a failing test.** Reproduce the bug deterministically in a test, then fix the root cause. Longer timeouts are not a fix.
- **Addresses are immutable.** Never override `author.address` or `community.address` or fall back to a derived one; `nameResolved` reports whether a name resolved.

## Pull requests

- Branch from `master` (fork the repository if you do not have write access) and keep each pull request to one topic.
- PRs are squash-merged, so the PR title becomes the commit and the release-note line. Use a [Conventional Commits](https://www.conventionalcommits.org/) title of at most 100 characters whose type matches the user-visible effect (`feat`, `fix`, `perf`, ...). Check it before opening the PR:

  ```bash
  printf '%s\n' "$TITLE" | npx commitlint --config commitlint.config.cjs
  npm run check:pr-title -- --title "$TITLE"
  ```

- Mark breaking changes with `!` in the title and a `BREAKING CHANGE:` note that tells downstream code what to change, as described in [docs/versioning.md](docs/versioning.md#breaking-changes).
- After changing `src/`, run `npm run build`. After changing `test/`, run `npx tsc --project test/tsconfig.json --noEmit`. Run the affected tests through `node test/run-test-config.js` as [docs/testing.md](docs/testing.md) describes.
- When a schema changes, update the README sections that describe it. When `DB_VERSION` changes, add a migration test. When you add a doc under `docs/`, add it to the [protocol docs index](docs/protocol/README.md).
- Pin new dependencies to exact versions with npm and commit `package-lock.json`. `npm install` sets up Husky hooks that run Prettier on staged source files and lint commit messages.
- Leave the `version` in `package.json`, `docs/CHANGELOG.md` and `dist/` alone. The release job owns them.

CI runs the Node, browser, RPC and protocol test suites on PRs that touch `src/`, `test/`, `rpc/`, `config/` or the package manifests, and checks every PR title. Review bots, including CodeRabbit, comment on PRs; the maintainer decides what is merged.

## License

pkc-js is licensed under [GPL-3.0-or-later](LICENSE). Contributions are accepted under the same license.

# Contributing to pkc-js

pkc-js is the TypeScript SDK for PKC (Public Key Communities), a serverless social protocol built on IPFS, IPNS and libp2p pubsub. It runs in Node and in browsers, and [bitsocial-cli](https://github.com/bitsocialnet/bitsocial-cli), [bitsocial-react-hooks](https://github.com/bitsocialnet/bitsocial-react-hooks) and the clients built on them depend on it. A successful CI run on `master` publishes a new version to npm whenever there are commits since the last tag, so `master` must stay releasable.

Before you start, read:

- [docs/testing.md](docs/testing.md) for setup, the test server and running tests, and [docs/building.md](docs/building.md) for how the Node and browser builds are produced.
- [AGENTS.md](AGENTS.md). Its Build, Testing and Code rules describe constraints of this codebase and apply to human contributors too; the rest covers coding-agent workflow.
- The [protocol docs index](docs/protocol/README.md). Read the doc for the area you are changing first; AGENTS.md maps source paths to docs.
- [docs/versioning.md](docs/versioning.md) for how releases are cut and how to mark a breaking change.

## Where to help

The [issue tracker](https://github.com/pkcprotocol/pkc-js/issues) is the backlog. For anything larger than a small fix, comment on the issue before starting so work is not duplicated, and open an issue first if none exists.

## Pull requests

- Branch from `master` (fork the repository if you do not have write access) and keep each pull request to one topic.
- PRs are squash-merged, so the PR title becomes the commit and the release-note line. Use a [Conventional Commits](https://www.conventionalcommits.org/) title of at most 100 characters whose type matches the user-visible effect (`feat`, `fix`, `perf`, ...). Check it before opening the PR:

  ```bash
  printf '%s\n' "$TITLE" | npx commitlint --config commitlint.config.cjs
  git fetch origin
  npm run check:pr-title -- --title "$TITLE" --base origin/master
  ```

  The second check reads the commits between the base and your branch. Without `--base` it compares against your local `master`, and a stale local `master` makes it count commits that are not yours. If you work from a fork, use the remote that points at `pkcprotocol/pkc-js`.

- Mark breaking changes with `!` in the title and a `BREAKING CHANGE:` note that tells downstream code what to change, as described in [docs/versioning.md](docs/versioning.md#breaking-changes).
- Leave the `version` in `package.json`, `docs/CHANGELOG.md` and `dist/` alone. The release job owns them.

CI runs the Node, browser, RPC and protocol test suites on PRs that touch `src/`, `test/`, `rpc/`, `config/` or the package manifests, and checks every PR title. Review bots, including CodeRabbit, comment on PRs; the maintainer decides what is merged.

## License

pkc-js is licensed under [GPL-3.0-or-later](LICENSE). Contributions are accepted under the same license.

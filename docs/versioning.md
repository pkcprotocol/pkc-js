# Versioning and releases

How pkc-js versions are chosen and published. Read this before changing the package version, marking a breaking change, preparing or debugging a release, or upgrading pkc-js in a downstream repo.

The release config is the source of truth: [`config/.release-it.json`](../config/.release-it.json) and [`.github/workflows/CI-build.yml`](../.github/workflows/CI-build.yml). If this document disagrees with them, they win and this document needs fixing.

## Every release is a `0.0.x` patch

Every release bumps the patch number on `0.0.x`, including releases that contain breaking changes. The release config sets `"increment": "patch"` and `"ignoreRecommendedBump": true`, so the conventional-commit types in a release do not change the number.

This dates from 990a2a0ad (2026-08-26). Before it, the conventional-commits parser read a body line starting "Breaking change in gossipsub 17.0.0:" as a `BREAKING CHANGE` note (it matches case-insensitively), and with `preMajor` that bumped the release to `0.1.0` instead of `0.0.87`. The `v0.1.0` tag never reached the remote, so the next run counted the same commit again and released `0.2.0`. Both versions are deprecated on npm ("accidental release, use 0.0.x"), and the `latest` dist-tag points at `0.0.x`.

### What the number tells consumers

npm treats `0.0.x` versions as mutually incompatible: `^0.0.135` matches only `0.0.135`. Downstream repos pin exact versions (on 2026-11-05, bitsocial-react-hooks pinned `0.0.132` and bitsocial-cli `0.0.134`), so a release reaches their users only when a downstream upgrade PR lands. The version number carries no compatibility signal. The release notes do, which is why the PR title and breaking-change markers below matter.

## When a release happens

1. A push to `master` that touches `src/`, `test/`, `rpc/`, `config/`, `.github/`, `package.json` or `package-lock.json` runs [CI](../.github/workflows/CI.yml).
2. When CI succeeds on `master`, **CI build** runs `npm run release -- --ci`. If there are commits since the last tag, release-it bumps the patch, prepends the notes to [`docs/CHANGELOG.md`](CHANGELOG.md), commits `chore(release): <version> [skip ci]` as the release bot, pushes the `v<version>` tag, and creates the GitHub release.
3. The same job publishes to npm with provenance through trusted publishing (npm 11; see the comments in the workflow for why it is pinned).

Consequences:

- Any merged change in those paths publishes a version, including test-only or CI-only changes. Their notes are empty if no commit has a visible type.
- Pushes that only touch other files, such as `docs/`, `README.md` or `AGENTS.md`, do not run CI or release. Their commits fall into the next release's range, where hidden types do not appear in the notes.
- Releases run one at a time (the `release` concurrency group). Two overlapping runs once both bumped to `0.0.113` from different commits.
- The release step ends in `|| true`, so a release-it failure still leaves the job green and the next step reports "No new version to release". To confirm a release, check the npm `latest` dist-tag and the GitHub release, not just the job status.

Do not edit `version` in `package.json` or `docs/CHANGELOG.md` by hand; the release job owns both.

## Release notes

The notes come from conventional commit subjects since the previous tag. Only these types get a section: `feat` (Features), `fix` (Bug Fixes), `perf` (Performance), `revert` (Reverts) and `build` (Build). `chore`, `docs`, `test`, `ci`, `refactor` and `style` commits are left out.

PRs are squash-merged, so the PR title becomes the only commit release-it sees. Give the title the type of the change's user-visible effect. The `lint-pr-title` CI job fails a title whose type would hide a releasable commit; run the same check locally with `npm run check:pr-title -- --title "$TITLE"` (see the Workflow rules in [AGENTS.md](../AGENTS.md)).

## Breaking changes

A breaking change still ships as the next patch, so mark it where downstream maintainers will see it:

- Add `!` after the type or scope in the PR title, for example `feat(pkc)!: list communities as objects`.
- Add a `BREAKING CHANGE: <what changed and what callers must do>` footer to the squash commit body. It becomes the text under "⚠ BREAKING CHANGES" in the release notes, so write it as migration guidance. 0.0.129 is an example: `pkc.communities` entries became objects and `communitieschange` listeners started receiving `{ communities }`.

Do not write "breaking change" at the start of a body line for anything else. The parser still turns such a line into a breaking-change note. It no longer changes the version, but it adds a false warning to the notes, and bitsocial-cli copies pkc-js notes into its own changelog when it upgrades.

Surfaces to check when deciding whether a change breaks callers:

- The API documented in the [README](../README.md): `PKC` options, methods, events, states and errors.
- The `exports` entry points in `package.json` (`.`, `./challenges`, `./page-sorts`, `./rpc`) and their TypeScript declarations.
- The RPC protocol between `./rpc` clients and servers, which may run different pkc-js versions.
- On-disk data: the database schema (`DB_VERSION` migrations) and the data path layout ([data-path-migration.md](protocol/data-path-migration.md)).
- Supported runtimes: `engines.node` (currently `>=22.19.0`) and browsers.

Wire-format and signature changes are a separate concern. Nodes running older pkc-js stay on the network, so they also affect interoperability, not only API callers. Read [wire-vs-runtime.md](protocol/wire-vs-runtime.md) and [signing.md](protocol/signing.md) before changing what goes on the wire.

## Upgrading pkc-js downstream

Read every `docs/CHANGELOG.md` entry between the pinned version and the target, not just the newest one; a breaking change can sit in any intermediate patch. Each "⚠ BREAKING CHANGES" note should say what the downstream code has to change.

## Leaving `0.0.x`

There is no plan or date for leaving `0.0.x`; that is a maintainer decision. If it happens:

- CI build runs release-it without `--increment`, so the configured `patch` applies. A deliberate minor or major release needs an explicit `--increment` (990a2a0ad left that option open), which means a one-off change to how the release job runs.
- npm never reuses a version number, and `0.1.0` and `0.2.0` already exist there, so the first release above `0.0.x` must be `0.3.0` or higher.
- From `0.y.z` with `y >= 1`, caret ranges accept later patches on the same line (`^0.3.0` accepts `0.3.1`). Patch releases would then have to stay compatible, and breaking changes would need the next minor.

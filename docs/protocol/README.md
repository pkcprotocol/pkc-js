# Protocol Documentation

Concise protocol reference for AI agents and contributors. Each doc covers one domain area.

| Doc | What it covers |
|-----|---------------|
| [comment-lifecycle.md](comment-lifecycle.md) | CommentPubsubMessage → CommentIpfs → CommentUpdate, who signs what, mutability |
| [wire-vs-runtime.md](wire-vs-runtime.md) | What goes on wire (IPFS/pubsub) vs what is computed at runtime |
| [names-and-addresses.md](names-and-addresses.md) | `address = name \|\| publicKey`, domain resolution, immutability |
| [delegated-ipns.md](delegated-ipns.md) | Delegated IPNS chains (anchor → minter → /ipfs), client-side loading & verification |
| [community-architecture.md](community-architecture.md) | Local vs Remote vs RPC variants, state machines |
| [signing.md](signing.md) | Ed25519 signatures, signedPropertyNames, CBORG encoding |
| [pages.md](pages.md) | Pagination, sort types, ephemeral nature of pages |
| [page-sorts.md](page-sorts.md) | `settings.pages`: choosing and preloading sorts, reserved options, `community.pageSorts`, writing a page sort file or package |
| [crossposts.md](crossposts.md) | `comment.crosspost`, the embedded record, tier-1 vs tier-2 verification, `features.noCrossposts` |
| [challenge-flow.md](challenge-flow.md) | 4-message encrypted challenge exchange |
| [challenge-settings.md](challenge-settings.md) | Private (`settings.challenges`) vs public (`challenges`) boundary, sensitive options |
| [challenge-authoring.md](challenge-authoring.md) | For challenge package authors: core `optionInputs` validation, the `validateChallengeSettings` hook, publication obligations |
| [data-permanence.md](data-permanence.md) | What is permanent (IPFS CIDs) vs ephemeral (regenerated) |
| [db-community-address-migration.md](db-community-address-migration.md) | DB v37 migration: subplebbitAddress → communityPublicKey/communityName, CID preservation |
| [data-path-migration.md](data-path-migration.md) | Directory layout migration for downstream apps: `.plebbit/` → `.pkc/`, `subplebbits/` → `communities/` |
| [import-performance.md](import-performance.md) | Import/startup cost (issue #120): how to benchmark it, where the time goes, optimization checklist + history |

## External specs

| Spec | Why it matters here |
|------|---------------------|
| [IPFS path-gateway spec](https://specs.ipfs.tech/http-gateways/path-gateway/) | The contract our ipfs-gateway transport polls against: `ETag` format and `If-None-Match`/304 revalidation, `Cache-Control: max-age` = remaining IPNS record TTL, `X-Ipfs-Roots`, HEAD + `only-if-cached` probes, and `?format=ipns-record` for fetching the verifiable IPNS record itself. Read before touching the gateway fetch path in `src/clients/base-client-manager.ts` or the gateway branch of `src/community/community-client-manager.ts`. |

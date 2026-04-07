# Protocol Documentation

Concise protocol reference for AI agents and contributors. Each doc covers one domain area.

| Doc | What it covers |
|-----|---------------|
| [comment-lifecycle.md](comment-lifecycle.md) | CommentPubsubMessage → CommentIpfs → CommentUpdate, who signs what, mutability |
| [wire-vs-runtime.md](wire-vs-runtime.md) | What goes on wire (IPFS/pubsub) vs what is computed at runtime |
| [names-and-addresses.md](names-and-addresses.md) | `address = name \|\| publicKey`, domain resolution, immutability |
| [community-architecture.md](community-architecture.md) | Local vs Remote vs RPC variants, state machines |
| [signing.md](signing.md) | Ed25519 signatures, signedPropertyNames, CBORG encoding |
| [pages.md](pages.md) | Pagination, sort types, ephemeral nature of pages |
| [challenge-flow.md](challenge-flow.md) | 4-message encrypted challenge exchange |
| [data-permanence.md](data-permanence.md) | What is permanent (IPFS CIDs) vs ephemeral (regenerated) |
| [db-subplebbit-address-migration.md](db-subplebbit-address-migration.md) | DB v37 migration: subplebbitAddress → communityPublicKey/communityName, CID preservation |
| [data-path-migration.md](data-path-migration.md) | Directory layout migration for downstream apps: `.plebbit/` → `.pkc/`, `subplebbits/` → `communities/` |

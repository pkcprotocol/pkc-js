# PKC-JS Renaming Guide

This document provides a comprehensive checklist for renaming the plebbit-js codebase:
- **plebbit** → **pkc**
- **subplebbit** → **community**

## Summary Statistics

- **Total "plebbit" occurrences:** ~12,729 across 318 files
- **Total "subplebbit" occurrences:** ~6,462 across 247 files
- **Source files:** 142 TypeScript/JavaScript files in src/
- **Test files:** 166 test files
- **Build output files:** 815 files in dist/

---

## Pre-Phase: Guide Refresh

- [x] Re-review the current codebase and update this guide before starting Phase 1, since this document was written a while ago and likely misses newer changes. *(Refreshed: 2026-03-09 — added missing test files, types/schemas, source files, resolved Q3/Q4)*

---

## Companion Document

**[NAMES_AND_PUBLIC_KEY_PROPOSAL.md](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md)** is a companion document that covers protocol-level changes applied alongside this rename:
- New schema fields (`name`, `communityPublicKey`, `communityName`)
- Wire format changes (removing `address` and `author.address` from wire)
- DB migrations for new columns
- New error codes (`ERR_CONFLICTING_ADDRESS_AND_PUBLICKEY`, `ERR_NAME_RESOLUTION_FAILED`, `ERR_NO_RESOLVER_FOR_NAME`)
- Serialization requirements (`address`, `name`, `publicKey` as enumerable instance properties)
- Backward compatibility strategy for old publications and records

---

## Phase 1: Web3 Modularization

Make plebbit-js (pkc-js) a neutral, core library that only handles IPNS/IPFS natively. Name resolution (.bso, ENS-based) and EVM challenges become external plugins in separate GitHub repos. `.sol` support has been removed entirely.

### Execution sub-order within Phase 1

This phase has internal ordering dependencies:
1. **Create `@bitsocial/bso-resolver`** in a separate git repo — extract ENS resolution code, make installable via git
2. **Implement `nameResolvers` plugin system** in pkc-js (1.1, 1.3 name resolver items)
3. **Extract `evm-contract-call`** to `@bitsocial/challenge-evm-contract` repo (1.3 challenge items)
4. **Remove built-in ENS logic and web3 deps** from pkc-js (1.3 dependency items — last step)

You cannot remove `viem`/`ethers` until `@bitsocial/bso-resolver` exists and the plugin system is implemented.

### 1.1 Name Resolver Plugin System

> **See [NAMES_AND_PUBLIC_KEY_PROPOSAL.md — Name resolving](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md#name-resolving) for the full API design** (resolver shape, resolution algorithm, client state tracking, and design rationale).

**Summary:** Name resolvers are an ordered array of `{key, resolve, canResolve, provider}` objects passed via `PkcOptions.nameResolvers`. One resolver per provider enables per-provider UI state tracking. Resolver composition (wiring account config to resolver objects) is a client/hook responsibility, not pkc-js.

**RPC-Side Resolution:**

Name resolution must happen on the RPC server side, not the client side. This allows RPC clients to resolve domain names even if they have zero resolvers configured locally.

- When an RPC client calls `getCommunity("memes.eth")`, the RPC server performs the resolution using its own registered resolvers
- RPC clients don't need `nameResolvers` config - they delegate resolution to the server
- The RPC server returns the resolved IPNS address to the client
- This is important for lightweight clients (browsers, mobile) that shouldn't need web3 dependencies

**Implementation considerations:**
- [x] Ensure RPC methods resolve names server-side — no standalone `getSubplebbit` RPC method exists; resolution happens server-side via `subplebbitUpdateSubscribe` and `createSubplebbit` which call `plebbit.createSubplebbit(parsedArgs)`, triggering `nameResolvers`
- [x] RPC client should NOT attempt local resolution before calling RPC — confirmed: `plebbit-rpc-client.ts` passes params directly to WebSocket calls
- [x] `subplebbitUpdateSubscribe` / `communityUpdateSubscribe` should accept domain names and resolve server-side — RPC server strips client nameResolvers and uses its own
- [x] Document that RPC servers need resolvers configured, not RPC clients — added to `docs/protocol/names-and-addresses.md` and `src/rpc/README.md`

### 1.2 External Challenge Registration

`Plebbit.challenges` already exists as a mutable static object. External challenges:
```javascript
import PKC from '@pkc/pkc-js';
import { evmContractCallChallenge } from '@bitsocial/challenge-evm-contract';

PKC.challenges['evm-contract-call'] = evmContractCallChallenge;
```

External challenges import types from plebbit-js:
```typescript
import { ChallengeFile, ChallengeFileFactory, Challenge, ChallengeResult } from '@pkc/pkc-js';
```

### 1.3 TODO Items

**Name Resolver System:**
- [x] Add `nameResolvers` option to `PKCUserOptionsSchema` (array of `{key, resolve, canResolve, provider}`)
- [x] Add `NameResolverClient` class with `state` and `statechange` event
- [x] Add `community.clients.nameResolvers` map (key → NameResolverClient)
- [x] Refactor `src/clients/base-client-manager.ts` resolution flow to use serial `canResolve`/`resolve` algorithm
- [x] Remove `chainProviders` from `PKCUserOptionsSchema` (breaking change)
- [x] Add `ERR_NO_RESOLVER_FOR_NAME` error when no resolver can handle a name
- [x] Remove hardcoded ENS logic from core (resolution moves to external @bitsocial/resolver-bso)
- [x] Remove all SNS/Solana resolution code (.sol support removed entirely)

**External Challenges:**
- [x] Remove `evm-contract-call` from `pkcJsChallenges` in `src/runtime/node/subplebbit/challenges/index.ts`
- [x] Delete `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/evm-contract-call/` directory
- [x] Remove `voucher` from `pkcJsChallenges` in `src/runtime/node/subplebbit/challenges/index.ts`
- [x] Delete `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/voucher.ts`
- [x] Export the minimal external challenge authoring types via the `./challenges` package subpath (`ChallengeFileInput`, `ChallengeInput`, `ChallengeResultInput`, `GetChallengeArgsInput`, `SubplebbitChallengeSetting`) for external packages like captcha challenge

**Dependencies (last step — after bso-resolver and plugin system are ready):**
- [x] Remove `viem` (moves to @bitsocial/bso-resolver and @bitsocial/challenge-evm-contract)
- [x] Remove `ethers` (moves to @bitsocial/bso-resolver)
- [x] Remove `@bonfida/spl-name-service` if present (no .sol support)
- [x] Remove `@solana/web3.js` if present (no .sol support)

**Downstream Apps:**
- [ ] Update plebbit-cli to install and register name resolvers
- [ ] Update desktop apps to install and register name resolvers

**Release & Distribution:**
- [ ] After rebrand, start publishing `@pkc/pkc-js` to the npm registry (deferred)
- [ ] Add GitHub CI job(s) to automate npm publishing for `@pkc/pkc-js` (deferred)

### 1.4 External Repos to Create

| Repository | Purpose | Dependencies | Status |
|------------|---------|--------------|--------|
| @bitsocial/bso-resolver | ENS (.bso) name resolution | viem, ethers | [x] Created: https://github.com/bitsocialnet/bso-resolver |
| @bitsocial/challenge-evm-contract | EVM contract call challenge | viem | [x] Created: https://github.com/bitsocialnet/evm-contract-call |
| @bitsocial/challenge-voucher | Voucher-based challenge | TBD | [x] Created: https://github.com/bitsocialnet/voucher-challenge |

Note: .sol support has been removed. Only ENS-based resolution (.bso) is supported.

### 1.5 Breaking Changes

- No default name resolvers — pkc-js only handles IPNS/IPFS natively
- Users must explicitly provide `nameResolvers` in `PkcOptions` to resolve `.bso` addresses (see [NAMES_AND_PUBLIC_KEY_PROPOSAL.md — Name resolving](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md#name-resolving) and [issue #68](https://github.com/plebbit/plebbit-js/issues/68#issuecomment-3900045187))
- `.sol` support removed entirely — only ENS-based resolution (.bso) is supported
- `evm-contract-call` and `voucher` challenges no longer built-in
- `chainProviders` removed from PlebbitOptions — now configured per-resolver in `nameResolvers` config
- Challenges fall back to resolver URLs, then to their own hardcoded defaults
- DNS TXT record lookups (`subplebbit-address`, `plebbit-author-address`) removed from pkc-js core — handled by resolver plugins (e.g., `@bitsocial/bso-resolver` uses `bitsocial` TXT record)
- `author.address` changes from required wire field to instance-only (computed as `author.name || author.publicKey`)
- `publication.subplebbitAddress` replaced by `communityPublicKey` + `communityName` wire fields (old publications remain loadable via backward compat parsing)

### 1.6 Challenge System Cleanup

**Step 1: Remove `.sol` from default challenge regexp** (separate from default challenge change):
- [x] In `_defaultSubplebbitChallenges` (`src/runtime/node/subplebbit/local-subplebbit.ts`), remove `.sol` from the `publication-match` regexp: `\\.(sol|eth|bso)$` → `\\.(eth|bso)$`
- Note: `.sol` support is being removed entirely. The entire publication-match default has been replaced by the `question` challenge in Step 3.
- [x] Ensure `author.address` is computed (as `name || publicKey`) and available on the publication instance when the local community processes incoming publications — `publication-match` challenge matches against it.
- [x] Add tests verifying `author.address` is computed and available when challenges process incoming publications (e.g., `publication-match` receives the computed `author.address`, not the raw wire field)
- Note: With `author.address = name || publicKey`, authors without a domain name will have a base58 key as `address` which never matches `\.(eth|bso)$` — effectively auto-passing the `publication-match` check. This is expected since the default challenge is changing to `question` in Step 3.

**Step 2: Remove built-in challenges** (must happen before or at the same time as Step 3):
- [x] Remove `mintpass` challenge from `plebbitJsChallenges`
  - Delete directory: `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/mintpass/`
  - Remove import and entry from: `src/runtime/node/subplebbit/challenges/index.ts`
  - Remove `@mintpass/challenge` dependency from `package.json`
- [x] Remove `captcha-canvas-v3` challenge from `plebbitJsChallenges` (extracted to `@bitsocial/captcha-canvas-challenge`)
  - Delete directory: `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/captcha-canvas-v3/`
  - Remove import and entry from: `src/runtime/node/subplebbit/challenges/index.ts`
  - Remove `captcha-canvas` and `skia-canvas` dependencies from `package.json`
- [x] Remove `voucher` challenge from `plebbitJsChallenges` (extracted to `@bitsocial/challenge-voucher`)
  - Delete file: `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/voucher.ts`
  - Remove import and entry from: `src/runtime/node/subplebbit/challenges/index.ts`

**Step 3: Change default challenge** (depends on Step 2 — old default references `mintpass`):
- [x] Change default challenge from `publication-match` to `question` (question/answer challenge)
  - File: `src/runtime/node/subplebbit/local-subplebbit.ts` (line ~198, `_defaultSubplebbitChallenges`)
  - Default `question`: `"Placeholder challenge. Set your own challenges otherwise you risk getting spammed"`
  - Default `answer`: `"Placeholder answer"`
  - **Note:** This only affects NEW communities created after the update. Existing communities keep their stored challenge configuration from their DB/internal state.

**Remaining built-in challenges after cleanup:**
After removing `captcha-canvas-v3`, `mintpass`, `voucher`, and extracting `evm-contract-call`, these challenges remain built-in:
- `text-math`
- `fail`
- `blacklist`
- `whitelist`
- `question`
- `publication-match`

---

## Phase 1B: Protocol Wire Format Changes

> **Do before the cosmetic rename (Phases 2–17).** These are functional/behavioral changes to the wire format and database. Isolating them from the rename makes issues easier to debug. Follows the proven `author.address` → instance-only pattern already implemented in `src/publications/publication-author.ts`.

### Step 1: SubplebbitIpfs — add `name`, make `address` instance-only

- [x] Add `name: z.string().min(1).optional()` to `SubplebbitIpfsSchema` (`src/subplebbit/schema.ts`)
- [x] Remove `address` from `SubplebbitIpfsSchema` wire definition (becomes instance-only)
- [x] Parsing already uses `.loose()` via `parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails`, so old records with `address` are accepted. Schema definition stays `.strict()` to preserve TypeScript types.
- [x] `SubplebbitSignedPropertyNames`: now includes `name` (from schema keys), excludes `address`
- [x] Add `name` to `SubplebbitEditOptionsSchema` so owners can set it via `sub.edit({ name: "memes.bso" })`
- [x] Make `address` instance-only on `RemoteSubplebbit`, computed as `name || publicKey`
- [x] Make `publicKey` instance-only on `RemoteSubplebbit`, derived from `signature.publicKey`
- [x] Make `nameResolved` instance-only on `RemoteSubplebbit` (`boolean | undefined`) — now a strictly runtime-only reserved field, rejected if signed in wire format across all publication types and SubplebbitIpfs. Non-blocking background resolution populates it. Propagated via RPC "runtimeupdate" event
- [x] `address` and `publicKey` appear in `JSON.stringify()` (enumerable own properties)
- [x] Create helper functions following the `publication-author.ts` pattern: `buildRuntimeSubplebbit()`, `cleanWireSubplebbit()`, `omitRuntimeSubplebbitFields()` — in `src/subplebbit/subplebbit-wire.ts`
- [x] `_toJSONIpfsBaseNoPosts()` automatically follows schema shape, so published format excludes `address` and includes `name`
- [x] Update signature verification (`verifySubplebbit` in `src/signer/signatures.ts`) — derives address from wire record for page verification; self-describing `signedPropertyNames` handles old records automatically
- [x] Add domain resolution verification for `subplebbit.name` — implemented via key migration: when domain resolves to a different public key, emit error, clear data, re-fetch with new key. Background resolution populates `nameResolved` for subplebbits loaded by IPNS key. Migration handling for name resolution changes during updates also added
- [x] `CreateRemoteSubplebbitOptionsSchema`: `address` now optional, added `publicKey` (B58 IPNS name), refinement requires at least one of `address`/`name`/`publicKey`
- [x] `createSubplebbit()` accepts `{name}`, `{publicKey}`, `{address}`, or combinations; `instance.address` always defined
- [x] Tests: old records with `address` in `signedPropertyNames` still verify; new records with `name`; `address` computed correctly; flexible `createSubplebbit` input (21 new tests in `test/node-and-browser/subplebbit/wire-format-migration.test.ts` and `test/node-and-browser/signatures/subplebbit.test.ts`)
- [x] `sub.edit({ name })` flow — `SubplebbitEditOptionsSchema` picks `name` from `SubplebbitIpfsSchema`. LocalSubplebbit's edit flow converts `address` → `name` when address is a domain. RPC edit path tested
- [x] `nameResolved` verification — covered by non-blocking background resolution pattern (author.name resolution moved from verification to background task) and key migration for subplebbit name resolution

### Step 2: Publications — add `communityPublicKey`/`communityName`, make `subplebbitAddress` instance-only

- [x] Add `communityPublicKey: z.string().min(1).optional()` and `communityName: z.string().min(1).optional()` to `CreatePublicationUserOptionsSchema` (`src/schema/schema.ts`)
- [x] Keep `subplebbitAddress` in `CreatePublicationUserOptionsSchema` as user-facing input — now renamed to `communityAddress` (instance-only, computed as `communityName || communityPublicKey`)
- [x] Make publication schemas `.loose()` to accept old records with `subplebbitAddress`
- [x] Update `signedPropertyNames` for all publication types: include `communityPublicKey`/`communityName`, exclude `subplebbitAddress`
- [x] Make `subplebbitAddress` instance-only on `Publication` — replaced by `communityAddress` = `communityName || communityPublicKey`
- [x] Create helper functions in `src/publications/publication-community.ts`: `buildRuntimeCommunityFields()`, `normalizeCommunityInputFromSubplebbit()`, `getCommunityPublicKeyFromWire()`, `getCommunityNameFromWire()`, `getCommunityAddressFromRecord()`, `preprocessCommentIpfsBackwardCompat()`
- [x] Resolution flow on creation: `publish()` calls `_initCommunity()` → `_signPublicationWithCommunityFields()` → sets `communityPublicKey` + optional `communityName` → strips `subplebbitAddress` before signing
- [x] Backward compat via `preprocessCommentIpfsBackwardCompat()`: old `CommentIpfs` with `subplebbitAddress` → IPNS key becomes `communityPublicKey`, domain becomes `communityName`
- [x] `LocalSubplebbit` normalizes old→new format on storage (deletes `subplebbitAddress`, sets community fields)
- [x] Tests in `community-fields.comment.test.ts` and `pubsubfields.comment.test.ts`: old publications with `subplebbitAddress` still load and verify; new publications with `communityPublicKey`/`communityName`; resolution flow; wire format verification

### Step 3: DB migration — new columns for publication fields

- [x] Bump `DB_VERSION` to 37 (`src/version.ts`)
- [x] Add columns to `comments`, `commentEdits`, `commentModerations` tables: `communityPublicKey TEXT`, `communityName TEXT`
- [x] `subplebbitAddress` completely removed from tables (preserved in `extraProps` for CID reconstruction)
- [x] Migration logic: backfill `communityPublicKey` from `subplebbitAddress` (IPNS key → `communityPublicKey`; domain → `communityName`); old `subplebbitAddress` stored in `extraProps`
- [x] `CommentsTableRowSchema` includes new optional columns via `CreatePublicationUserOptionsSchema`
- [x] `queryComment()` returns new columns via `CommentsTableRow` type
- [x] Tests in `test/node/subplebbit/v36-to-v37.migration.db.subplebbit.test.ts`: DB version check, column changes, migration logic for IPNS/domain addresses, extraProps preservation/merging, CID reproducibility via `deriveCommentIpfsFromCommentTableRow()`

---

## Phase 2: Package Configuration & Project Files

### 2.1 Package Identity
- [x] **package.json** - Rename package
  - `"name": "@plebbit/plebbit-js"` → `"name": "@pkc/pkc-js"`
  - Update `"repository"` URL if moving to new GitHub org
  - Update `"bugs"` URL
  - Update `"homepage"` URL
  - Update keywords: `"plebbit"`, `"plebbit-js"` → `"pkc"`, `"pkc-js"`
  - Update description

- [x] **rpc/package.json** - Rename RPC package
  - `"name": "@plebbit/plebbit-js-rpc"` → `"name": "@pkc/pkc-js-rpc"`
  - Update repository URLs

### 2.2 External Dependencies (Document for Later)
The following dependencies are in the @plebbit namespace and need separate repository work (rename AFTER pkc-js rename):
- [x] `@plebbit/plebbit-logger` → `@pkc/pkc-logger` - Done
- [x] `@plebbit/proper-lockfile` → `@pkc/proper-lock-file` - Done

### 2.3 RPC Package Configuration
- [x] **rpc/package.json** - Update keywords
  - `"keywords": ["plebbit", "subplebbit"]` → `"keywords": ["pkc", "community"]`

### 2.4 Root Files
- [x] **README.md** - Complete rewrite
  - Replace all "plebbit" → "pkc" (case-sensitive variations)
  - Replace all "subplebbit" → "community"
  - Replace all "Subplebbit" → "Community"
  - Update GitHub URLs if moving repos

- [x] **CLAUDE.md** / **AGENTS.md** - Update references

- [x] **project.json** - Update project metadata

---

## Phase 3: Directory Structure Renaming

### 3.1 Source Directories
- [x] `src/plebbit/` → `src/pkc/`
- [x] `src/subplebbit/` → `src/community/`
- [x] `src/publications/subplebbit-edit/` → `src/publications/community-edit/`
- [x] `src/runtime/node/subplebbit/` → `src/runtime/node/community/`
- [x] `src/runtime/browser/subplebbit/` → `src/runtime/browser/community/`
- [x] `src/rpc/src/lib/plebbit-js/` → `src/rpc/src/lib/pkc-js/`
- [x] `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/` → `src/runtime/node/community/challenges/pkc-js-challenges/`

### 3.2 Test Directories
- [x] `test/node/subplebbit/` → `test/node/community/`
- [x] `test/node/subplebbit/challenges/` → `test/node/community/challenges/`
- [x] `test/node/subplebbit/pubsub-msgs/` → `test/node/community/pubsub-msgs/`
- [x] `test/node/plebbit/` → `test/node/pkc/`
- [x] `test/node-and-browser/subplebbit/` → `test/node-and-browser/community/`
- [x] `test/node-and-browser/subplebbit/posts/` → `test/node-and-browser/community/posts/`
- [x] `test/node-and-browser/subplebbit/modqueue/` → `test/node-and-browser/community/modqueue/`
- [x] `test/node-and-browser/plebbit/` → `test/node-and-browser/pkc/`
- [x] `test/node-and-browser/publications/subplebbit-edit/` → `test/node-and-browser/publications/community-edit/`
- [x] `test/fixtures/signatures/subplebbit/` → `test/fixtures/signatures/community/`

### 3.3 Data Storage Directories (Breaking Change)
- [x] Default data path changes: `subplebbits/` → `communities/`
- [x] Note: Migration code for old paths should be implemented in user-facing clients (plebbit-cli, desktop apps), NOT in pkc-js itself

---

## Phase 4: Source File Renaming

### 4.1 Plebbit → PKC Files
- [x] `src/plebbit/plebbit.ts` → `src/pkc/pkc.ts`
- [x] `src/plebbit/plebbit-with-rpc-client.ts` → `src/pkc/pkc-with-rpc-client.ts`
- [x] `src/plebbit/plebbit-client-manager.ts` → `src/pkc/pkc-client-manager.ts`
- [x] `src/plebbit/plebbit-clients.ts` → `src/pkc/pkc-clients.ts`
- [x] `src/clients/rpc-client/plebbit-rpc-client.ts` → `src/clients/rpc-client/pkc-rpc-client.ts`
- [x] `src/clients/plebbit-typed-emitter.ts` → `src/clients/pkc-typed-emitter.ts`
- [x] `src/plebbit-error.ts` → `src/pkc-error.ts`
- [x] `src/helia/helia-for-plebbit.ts` → `src/helia/helia-for-pkc.ts`
- [x] `src/rpc/src/lib/plebbit-js/index.ts` → `src/rpc/src/lib/pkc-js/index.ts` (rename internal symbols: `PlebbitJs` → `PKCJs`, `setPlebbitJs` → `setPKCJs`, `restorePlebbitJs` → `restorePKCJs`)
- [x] `src/rpc/src/lib/plebbit-js/plebbit-js-mock.ts` → `src/rpc/src/lib/pkc-js/pkc-js-mock.ts`
- [x] `src/version.ts` - Update USER_AGENT string:
  - `/plebbit-js:${version}/` → `/pkc-js:${version}/`
- [x] `src/test/node/hanging-test/scenarios/subplebbit-start.scenario.ts` → `src/test/node/hanging-test/scenarios/community-start.scenario.ts`
- [x] `src/test/node/hanging-test/scenarios/subplebbit-update.scenario.ts` → `src/test/node/hanging-test/scenarios/community-update.scenario.ts`
- [x] `src/rpc/test/node-and-browser/edgecases.plebbit.rpc.test.ts` → `src/rpc/test/node-and-browser/edgecases.pkc.rpc.test.ts`
- [x] `src/rpc/test/node-and-browser/concurrency.plebbit.rpc.test.ts` → `src/rpc/test/node-and-browser/concurrency.pkc.rpc.test.ts`

### 4.2 Subplebbit → Community Files
- [x] `src/subplebbit/remote-subplebbit.ts` → `src/community/remote-community.ts`
- [x] `src/subplebbit/rpc-remote-subplebbit.ts` → `src/community/rpc-remote-community.ts`
- [x] `src/subplebbit/rpc-local-subplebbit.ts` → `src/community/rpc-local-community.ts`
- [x] `src/subplebbit/subplebbit-clients.ts` → `src/community/community-clients.ts`
- [x] `src/subplebbit/subplebbit-client-manager.ts` → `src/community/community-client-manager.ts`
- [x] `src/publications/subplebbit-edit/subplebbit-edit.ts` → `src/publications/community-edit/community-edit.ts`
- [x] `src/runtime/node/subplebbit/local-subplebbit.ts` → `src/runtime/node/community/local-community.ts`
- [x] `src/runtime/node/subplebbit/db-handler.ts` → `src/runtime/node/community/db-handler.ts`
- [x] `src/runtime/node/subplebbit/page-generator.ts` → `src/runtime/node/community/page-generator.ts`
- [x] `src/runtime/node/subplebbit/db-handler-types.ts` → `src/runtime/node/community/db-handler-types.ts` (contains `SubplebbitIpfsType` imports)
- [x] `src/runtime/node/subplebbit/db-row-parser.ts` → `src/runtime/node/community/db-row-parser.ts`
- [x] `src/runtime/node/subplebbit/keyv-better-sqlite3.ts` → `src/runtime/node/community/keyv-better-sqlite3.ts` (imports `PlebbitError`)
- [x] `src/runtime/browser/subplebbit/local-subplebbit.ts` → `src/runtime/browser/community/local-community.ts`

### 4.3 Challenge System Files
- [x] `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/index.ts` - Export rename:
  - `plebbitJsChallenges` → `pkcJsChallenges`
- [x] `src/runtime/browser/subplebbit/challenges/` → `src/runtime/browser/community/challenges/`

### 4.4 Test File Renaming

**Note:** All test files should use the `.test.ts` TypeScript extension.

All test files in test/node/subplebbit/ and test/node-and-browser/subplebbit/:
- [x] `*.subplebbit.test.ts` → `*.community.test.ts`

**test/node/plebbit/** (directory to be renamed to test/node/pkc/):
- [x] `plebbit.test.ts` → `pkc.test.ts`
- [x] `validatecomment.plebbit.test.ts` → `validatecomment.pkc.test.ts`
- [x] `started-subplebbits.test.ts` → `started-communities.test.ts`

**test/node-and-browser/plebbit/** (directory to be renamed to test/node-and-browser/pkc/):
- [x] `_updatingSubplebbits.plebbit.test.ts` → `_updatingCommunities.pkc.test.ts`

---

## Phase 5: Import Path Updates

After renaming directories and files, update ALL import statements across the codebase:

### 5.1 Core Imports
- [x] `from "./plebbit/plebbit.js"` → `from "./pkc/pkc.js"`
- [x] `from "./plebbit/plebbit-with-rpc-client.js"` → `from "./pkc/pkc-with-rpc-client.js"`
- [x] `from "./plebbit/plebbit-client-manager.js"` → `from "./pkc/pkc-client-manager.js"`
- [x] `from "./subplebbit/..."` → `from "./community/..."`
- [x] `from "../plebbit-error.js"` → `from "../pkc-error.js"`

### 5.2 Publication Imports
- [x] `from "./publications/subplebbit-edit/..."` → `from "./publications/community-edit/..."`

### 5.3 Runtime Imports
- [x] `from "./runtime/node/subplebbit/..."` → `from "./runtime/node/community/..."`
- [x] `from "./runtime/browser/subplebbit/..."` → `from "./runtime/browser/community/..."`

---

## Phase 6: Class, Type & Interface Renaming

### 6.1 Main Classes (src/plebbit/ → src/pkc/)
- [x] Factory function `Plebbit()` → `PKC()` (src/index.ts — async factory function, the default export)
- [x] `Plebbit.challenges` → `PKC.challenges` (static property on factory function)
- [x] `Plebbit.setNativeFunctions` → `PKC.setNativeFunctions`
- [x] `Plebbit.nativeFunctions` → `PKC.nativeFunctions`
- [x] `Plebbit.getShortCid` → `PKC.getShortCid`
- [x] `Plebbit.getShortAddress` → `PKC.getShortAddress`
- [x] `class Plebbit` → `class PKC`
- [x] `class PlebbitWithRpcClient` → `class PKCWithRpcClient`
- [x] `class PlebbitRpcClient` → `class PKCRpcClient`
- [x] `class PlebbitTypedEmitter` → `class PKCTypedEmitter`
- [x] `class PlebbitClientsManager` → `class PKCClientsManager`
- [x] `class PlebbitError` → `class PKCError`
- [x] `class PlebbitIpfsGatewayClient` → `class PKCIpfsGatewayClient`
- [x] `class PlebbitKuboRpcClient` → `class PKCKuboRpcClient`
- [x] `class PlebbitLibp2pJsClient` → `class PKCLibp2pJsClient`
- [x] `class PublicationPlebbitRpcStateClient` → `class PublicationPKCRpcStateClient` (src/publications/publication-clients.ts)
- [x] `class CommentPlebbitRpcStateClient` → `class CommentPKCRpcStateClient` (src/publications/comment/comment-clients.ts)
- [x] `class PublicationClientsManager` → rename only if base class `PlebbitClientsManager` rename propagates (src/publications/publication-client-manager.ts)
- [x] `class PlebbitWsServer` → `class PKCWsServer` (src/rpc/src/index.ts — non-exported, but internal RPC server class)

### 6.2 Subplebbit Classes (src/subplebbit/ → src/community/)
- [x] `class RemoteSubplebbit` → `class RemoteCommunity`
- [x] `class RpcRemoteSubplebbit` → `class RpcRemoteCommunity`
- [x] `class RpcLocalSubplebbit` → `class RpcLocalCommunity`
- [x] `class LocalSubplebbit` → `class LocalCommunity`
- [x] `class SubplebbitClientsManager` → `class CommunityClientsManager`
- [x] `class SubplebbitKuboPubsubClient` → `class CommunityKuboPubsubClient`
- [x] `class SubplebbitKuboRpcClient` → `class CommunityKuboRpcClient`
- [x] `class SubplebbitPlebbitRpcStateClient` → `class CommunityPKCRpcStateClient`
- [x] `class SubplebbitLibp2pJsClient` → `class CommunityLibp2pJsClient`
- [x] `class SubplebbitIpfsGatewayClient` → `class CommunityIpfsGatewayClient`
- [x] `class SubplebbitEdit` → `class CommunityEdit`
- [x] `class SubplebbitPostsPagesClientsManager` → `class CommunityPostsPagesClientsManager` (src/pages/pages-client-manager.ts)
- [x] `class SubplebbitModQueueClientsManager` → `class CommunityModQueueClientsManager` (src/pages/pages-client-manager.ts)
- [x] `class PagesPlebbitRpcStateClient` → `class PagesPKCRpcStateClient` (src/pages/pages-clients.ts)

### 6.3 Type Definitions (src/types.ts, src/subplebbit/types.ts)
**Plebbit types:**
- [x] `interface PlebbitEvents` → `interface PKCEvents` (includes renaming event key `"subplebbitschange"` → `"communitieschange"` in the interface definition)
- [x] `interface PlebbitRpcClientEvents` → `interface PKCRpcClientEvents`
- [x] `interface ParsedPlebbitOptions` → `interface ParsedPKCOptions`
- [x] `type InputPlebbitOptions` → `type InputPKCOptions`
- [x] `type PlebbitMemCaches` → `type PKCMemCaches`
- [x] `interface PlebbitIpnsGetOptions` → `interface PKCIpnsGetOptions`
- [x] `interface PlebbitWsServerClassOptions` → `interface PKCWsServerClassOptions`
- [x] `type PlebbitWsServerSettingsSerialized` → `type PKCWsServerSettingsSerialized`
- [x] `type PlebbitRpcServerEvents` → `type PKCRpcServerEvents`
- [x] `type PlebbitRecordToVerify` → `type PKCRecordToVerify`
- [x] `type IpfsSubplebbitStats` → `type IpfsCommunityStats` (src/types.ts)
- [x] `type PubsubSubplebbitStats` → `type PubsubCommunityStats` (src/types.ts)
- [x] `type ResultOfFetchingSubplebbit` → `type ResultOfFetchingCommunity` (src/types.ts)

**Subplebbit types:**
- [x] `type SubplebbitStats` → `type CommunityStats`
- [x] `type SubplebbitFeatures` → `type CommunityFeatures`
- [x] `type SubplebbitSuggested` → `type CommunitySuggested`
- [x] `type SubplebbitEncryption` → `type CommunityEncryption`
- [x] `type SubplebbitRole` → `type CommunityRole`
- [x] `type SubplebbitRoleNameUnion` → `type CommunityRoleNameUnion`
- [x] `type SubplebbitIpfsType` → `type CommunityIpfsType`
- [x] `interface SubplebbitSignature` → `interface CommunitySignature`
- [x] `type SubplebbitChallenge` → `type CommunityChallenge`
- [x] `type SubplebbitChallengeSetting` → `type CommunityChallengeSetting`
- [x] `type SubplebbitSettings` → `type CommunitySettings`
- [x] `type SubplebbitState` → `type CommunityState`
- [x] `type SubplebbitStartedState` → `type CommunityStartedState`
- [x] `type SubplebbitUpdatingState` → `type CommunityUpdatingState`
- [x] `type SubplebbitJson` → `type CommunityJson`
- [x] `interface SubplebbitEvents` → `interface CommunityEvents`
- [x] `type RemoteSubplebbitJson` → `type RemoteCommunityJson`
- [x] `type RpcRemoteSubplebbitJson` → `type RpcRemoteCommunityJson`
- [x] `type RpcLocalSubplebbitJson` → `type RpcLocalCommunityJson`
- [x] `type LocalSubplebbitJson` → `type LocalCommunityJson`
- [x] `type CreateRemoteSubplebbitOptions` → `type CreateRemoteCommunityOptions`
- [x] `type CreateNewLocalSubplebbitUserOptions` → `type CreateNewLocalCommunityUserOptions`
- [x] `type CreateNewLocalSubplebbitParsedOptions` → `type CreateNewLocalCommunityParsedOptions`
- [x] `type SubplebbitEditOptions` → `type CommunityEditOptions`
- [x] `type ParsedSubplebbitEditOptions` → `type ParsedCommunityEditOptions`
- [x] All `*WithSubplebbitAuthor` types → `*WithCommunityAuthor`
- [x] `type InternalSubplebbitRecordBeforeFirstUpdateType` → `type InternalCommunityRecordBeforeFirstUpdateType` (src/subplebbit/types.ts)
- [x] `type InternalSubplebbitRecordAfterFirstUpdateType` → `type InternalCommunityRecordAfterFirstUpdateType` (src/subplebbit/types.ts)
- [x] `type RpcInternalSubplebbitRecordBeforeFirstUpdateType` → `type RpcInternalCommunityRecordBeforeFirstUpdateType` (src/subplebbit/types.ts)
- [x] `type RpcInternalSubplebbitRecordAfterFirstUpdateType` → `type RpcInternalCommunityRecordAfterFirstUpdateType` (src/subplebbit/types.ts)
- [x] `type RpcLocalSubplebbitUpdateResultType` → `type RpcLocalCommunityUpdateResultType` (src/subplebbit/types.ts)
- [x] `type SubplebbitEventArgs` → `type CommunityEventArgs` (src/subplebbit/types.ts)
- [x] `type SubplebbitRpcErrorToTransmit` → `type CommunityRpcErrorToTransmit` (src/subplebbit/types.ts)

**SubplebbitEdit types (src/publications/subplebbit-edit/types.ts):**
- [x] `type CreateSubplebbitEditPublicationOptions` → `type CreateCommunityEditPublicationOptions`
- [x] `type SubplebbitEditChallengeRequestToEncryptType` → `type CommunityEditChallengeRequestToEncryptType`
- [x] `type SubplebbitEditJson` → `type CommunityEditJson`
- [x] `interface SubplebbitEditPublicationOptionsToSign` → `interface CommunityEditPublicationOptionsToSign`
- [x] `interface SubplebbitEditPublicationSignature` → `interface CommunityEditPublicationSignature`
- [x] `type SubplebbitEditPubsubMessagePublication` → `type CommunityEditPubsubMessagePublication`
- [x] `interface SubplebbitEditPublicationPubsubMessageWithSubplebbitAuthor` → `interface CommunityEditPublicationPubsubMessageWithCommunityAuthor`

**SubplebbitEdit schemas (src/publications/subplebbit-edit/schema.ts):**
- [x] `CreateSubplebbitEditPublicationOptionsSchema` → `CreateCommunityEditPublicationOptionsSchema`
- [x] `SubplebbitEditPubsubMessagePublicationSchema` → `CommunityEditPubsubMessagePublicationSchema`
- [x] `SubplebbitEditPublicationChallengeRequestToEncryptSchema` → `CommunityEditPublicationChallengeRequestToEncryptSchema`
- [x] `SubplebbitEditPublicationPubsubReservedFields` → `CommunityEditPublicationPubsubReservedFields`

**Subplebbit schema constants (src/subplebbit/schema.ts):**
- [x] `SubplebbitIpfsReservedFields` → `CommunityIpfsReservedFields`

**RPC types (src/rpc/src/types.ts):**
- [x] `interface RpcSubplebbitState` → `interface RpcCommunityState`

---

## Phase 7: Schema Renaming (Zod)

### 7.1 Main Schemas (src/schema.ts)
- [x] `PlebbitUserOptionBaseSchema` → `PKCUserOptionBaseSchema`
- [x] `PlebbitUserOptionsSchema` → `PKCUserOptionsSchema`
- [x] `PlebbitParsedOptionsSchema` → `PKCParsedOptionsSchema`
- [x] Property: `plebbitRpcClientsOptions` → `pkcRpcClientsOptions`

### 7.2 Author & Shared Schemas (src/schema/schema.ts)
- [x] `SubplebbitAddressSchema` → `CommunityAddressSchema`
- [x] `PlebbitTimestampSchema` → `PKCTimestampSchema`
- [x] `SubplebbitAuthorSchema` → `CommunityAuthorSchema`
- [x] **Remove** `address` from `AuthorPubsubSchema` — now instance-only, computed as `name || publicKey` (**breaking change**). `AuthorIpfsSchema` was also removed (no separate schema exists).
- [x] **Add** `name: z.string().min(1).optional()` to `AuthorPubsubSchema` (wire field — domain name like `"vitalik.bso"`)
- [x] Use `.loose()` on author schemas to accept old records with `address` field (used on `CreatePublicationUserOptionsSchema.author`)

### 7.3 Subplebbit Schemas (src/subplebbit/schema.ts)
- [x] `SubplebbitEncryptionSchema` → `CommunityEncryptionSchema`
- [x] `SubplebbitRoleSchema` → `CommunityRoleSchema`
- [x] `SubplebbitRoleNames` → `CommunityRoleNames`
- [x] `SubplebbitSuggestedSchema` → `CommunitySuggestedSchema`
- [x] `SubplebbitFeaturesSchema` → `CommunityFeaturesSchema`
- [x] `SubplebbitChallengeSettingSchema` → `CommunityChallengeSettingSchema`
- [x] `SubplebbitChallengeSchema` → `CommunityChallengeSchema`
- [x] `SubplebbitIpfsSchema` → `CommunityIpfsSchema`
- [x] `SubplebbitSignedPropertyNames` → `CommunitySignedPropertyNames`
- [x] `SubplebbitSignatureSchema` → `CommunitySignatureSchema`
- [x] `CreateRemoteSubplebbitOptionsSchema` → `CreateRemoteCommunityOptionsSchema`
- [x] `SubplebbitSettingsSchema` → `CommunitySettingsSchema`
- [x] `SubplebbitEditOptionsSchema` → `CommunityEditOptionsSchema`
- [x] `SubplebbitEditPublicationChallengeRequestToEncryptSchema` → `CommunityEditPublicationChallengeRequestToEncryptSchema`
- [x] `CreateRemoteSubplebbitFunctionArgumentSchema` → `CreateRemoteCommunityFunctionArgumentSchema`
- [x] `CreateNewLocalSubplebbitUserOptionsSchema` → `CreateNewLocalCommunityUserOptionsSchema`
- [x] `CreateNewLocalSubplebbitParsedOptionsSchema` → `CreateNewLocalCommunityParsedOptionsSchema`
- [x] `ChallengeExcludeSubplebbitSchema` → `ChallengeExcludeCommunitySchema`
- [x] `ChallengeExcludeSchema` field: `subplebbit` → `community` (the field name referencing `ChallengeExcludeCommunitySchema`)
- [x] `ChallengeExcludePublicationTypeSchema` field: `subplebbitEdit` → `communityEdit`
- [x] `DecryptedChallengeRequestPublicationSchema` field: `subplebbitEdit` → `communityEdit` (pubsub wire format — done in Phase 18 cleanup)
- [x] `RpcRemoteSubplebbitUpdateEventResultSchema` → `RpcRemoteCommunityUpdateEventResultSchema`
- [x] **Remove** `address` from `SubplebbitIpfsSchema` — instance-only, computed as `name || publicKey` (see [proposal](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md#1-add-name-field-to-subplebbitipfs))
- [x] Use `.loose()` on `SubplebbitIpfsSchema` to accept old records that include `address` field (do NOT use `.strip()` — stripping can remove fields referenced in `signedPropertyNames` and corrupt signature verification)
- [x] `CreateRpcSubplebbitFunctionArgumentSchema` → `CreateRpcCommunityFunctionArgumentSchema` (src/subplebbit/schema.ts)
- [x] `ListOfSubplebbitsSchema` → `ListOfCommunitiesSchema` (src/subplebbit/schema.ts)

### 7.4 RPC Client Schemas (src/clients/rpc-client/schema.ts)
- [x] `RpcSubplebbitAddressParamSchema` → `RpcCommunityAddressParamSchema`
- [x] `RpcSubplebbitPageParamSchema` → `RpcCommunityPageParamSchema`

### 7.4.1 RPC Server Schemas (src/rpc/src/schema.ts)
- [x] `CreatePlebbitWsServerOptionsSchema` → `CreatePKCWsServerOptionsSchema`
- [x] `SetNewSettingsPlebbitWsServerSchema` → `SetNewSettingsPKCWsServerSchema`
- [x] `PlebbitWsServerSettingsSerializedSchema` → `PKCWsServerSettingsSerializedSchema`

### 7.4.2 RPC Server Types (src/rpc/src/types.ts)
- [x] `type CreatePlebbitWsServerOptions` → `type CreatePKCWsServerOptions`
- [x] `type SetNewSettingsPlebbitWsServer` → `type SetNewSettingsPKCWsServer`

### 7.4.3 SubplebbitEdit Schemas (src/publications/subplebbit-edit/schema.ts)
- [x] `SubplebbitEditPublicationSignedPropertyNames` → `CommunityEditPublicationSignedPropertyNames`

### 7.4.4 Publication Comment Types (src/publications/comment/types.ts)
- [x] `type SubplebbitAuthor` → `type CommunityAuthor`

### 7.5 Signed Property Names

Update the `signedPropertyNames` arrays to reflect wire format changes:
- [x] `SubplebbitSignedPropertyNames`: `name` included, `address` excluded (done in Phase 1B Step 1)
- [x] Publication signed property names: `communityPublicKey`/`communityName` included, `subplebbitAddress` excluded (done in Phase 1B Step 2)
- [x] Author signed property names: `name` included, `address` excluded (done in Phase 1 author.address migration)

**Note:** Old records with old `signedPropertyNames` remain valid — self-describing signature verification reads `signedPropertyNames` from each record. No explicit protocol version field is needed for backward compatibility.

### 7.6 Schema Parser Functions (src/schema/schema-util.ts)
- [x] All `parse*PlebbitErrorIfItFails` → `parse*PKCErrorIfItFails`
- [x] All `parse*SubplebbitSchemaWithPlebbitErrorIfItFails` → `parse*CommunitySchemaWithPKCErrorIfItFails`

### 7.7 Backward Compatibility Tests for Old Records

Add tests to verify old records with legacy field names are parsed correctly:
- [x] Test parsing old `SubplebbitIpfs` records that include `address` field (should be accepted via `.loose()`)
- [x] Test parsing old `CommentIpfs` records that include `subplebbitAddress` field (should be accepted via `.loose()`)
- [x] Test parsing old `AuthorPubsub` records that include `address` field (should be accepted via `.loose()`)
- [x] Test signature verification of old records with old `signedPropertyNames` (self-describing verification should still pass)

**Important:** Use `.loose()` not `.strip()` when parsing old records — `.strip()` can remove fields referenced in `signedPropertyNames` and corrupt signature verification.

---

## Phase 8: API Method & Property Renaming

### 8.1 Plebbit/PKC Class Methods
- [x] `plebbit.createSubplebbit()` → `pkc.createCommunity()`
- [x] `plebbit.getSubplebbit()` → `pkc.getCommunity()`
- [x] `plebbit.listSubplebbits()` → `pkc.listCommunities()`

### 8.1.1 PlebbitWithRpcClient Internal Methods
- [x] `_initPlebbitRpcClients()` → `_initPKCRpcClients()`

### 8.2 Plebbit/PKC Class Properties
- [x] `plebbit.subplebbits` → `pkc.communities`
- [x] `plebbit._updatingSubplebbits` → `pkc._updatingCommunities`
- [x] `plebbit._startedSubplebbits` → `pkc._startedCommunities`
- [x] `plebbit._subplebbitFsWatchAbort` → `pkc._communityFsWatchAbort`
- [x] `plebbit.plebbitRpcClientsOptions` → `pkc.pkcRpcClientsOptions`
- [x] `plebbit._plebbitRpcClient` → `pkc._pkcRpcClient`
- [x] `plebbit._userPlebbitOptions` → `pkc._userPKCOptions`
- [x] `plebbit._memCaches` (type change to PKCMemCaches)
- [x] `plebbit.clients.plebbitRpcClients` → `pkc.clients.pkcRpcClients`

### 8.2.0 Plebbit/PKC Class Event Names
Class-level events (not RPC — those are in Phase 9.2):
- [x] `"subplebbitschange"` → `"communitieschange"` (emitted by `Plebbit`/`PKC` class in `src/pkc/pkc.ts`)

### 8.2.1 PlebbitRpcClient Internal Properties
- [x] `PlebbitRpcClient.subplebbits` → `PKCRpcClient.communities` (array tracking community addresses received via RPC)

### 8.2.2 Utility Functions (src/runtime/node/util.ts)
- [x] `getDefaultSubplebbitDbConfig()` → `getDefaultCommunityDbConfig()`
- [x] `deleteOldSubplebbitInWindows()` → `deleteOldCommunityInWindows()`

### 8.2.3 RPC Schema Utility Functions (src/clients/rpc-client/rpc-schema-util.ts)
- [x] `parseRpcSubplebbitAddressParam()` → `parseRpcCommunityAddressParam()`
- [x] `parseRpcSubplebbitPageParam()` → `parseRpcCommunityPageParam()`

### 8.2.4 RPC Client Types (src/clients/rpc-client/types.ts)
- [x] `SubplebbitAddressRpcParam` → `CommunityAddressRpcParam`
- [x] `SubplebbitPageRpcParam` → `CommunityPageRpcParam`

### 8.3 Publication Properties (Breaking Change)
**See [NAMES_AND_PUBLIC_KEY_PROPOSAL.md](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md) for wire format decisions.**
- [x] `publication.subplebbitAddress` → replace with wire fields `communityPublicKey` (optional, for backward compat) + `communityName` (optional); `communityAddress` is instance-only (computed as `communityName || communityPublicKey`)
- [x] `publication.shortSubplebbitAddress` → `publication.shortCommunityAddress`
  - **Note:** This is a different property from `community.shortAddress` (on RemoteSubplebbit/RemoteCommunity, derived from `community.address`). `community.shortAddress` stays as `shortAddress` — no rename needed. Only the publication-level `shortSubplebbitAddress` is renamed.

**Backward compatibility for old publications:**
- `communityPublicKey` is **optional** in the wire schema. Required for new publications, absent on old ones.
- When parsing old `CommentIpfs` records that have `subplebbitAddress` but no `communityPublicKey`:
  - If `subplebbitAddress` is an IPNS key → use it as `communityPublicKey`
  - If `subplebbitAddress` is a domain → fill `communityPublicKey` from community context (the community serving the page/update knows its own publicKey)
- Old comments remain loadable.

### 8.3.1 Author Properties (Breaking Change)
- [x] `author.subplebbit` → `author.community` (property on AuthorIpfsSchema containing community-specific author data)
- [x] `author.address` → changes from **required wire field** to **instance-only** (computed as `author.name || author.publicKey`). This is a breaking change.
- [x] Add `author.name` as **wire field** in `AuthorPubsubSchema` and `AuthorIpfsSchema` — a domain name (e.g., `"vitalik.bso"`) pointing to the author's public key, same concept as `community.name`
- [x] `author.publicKey` — **instance-only**, derived from `signature.publicKey`
- [x] `author.nameResolved` — **instance-only**, runtime verification flag (`boolean | undefined`). Tested extensively in `test/node-and-browser/publications/comment/author-name-resolved.test.ts`

**Backward compatibility for old publications:**
- Old publications have `author.address` as a signed wire field. When parsing, ignore the wired value and compute instance-only `address = name || publicKey`.
- `author.displayName` is unrelated to `author.name` — `displayName` is a free-text label, `name` is a domain identity. Both are kept.
- `author.subplebbit` → `author.community`: **No backward compatibility concern.** The `author.subplebbit` key appears inside the `author` field of `CommentUpdate` records (not `CommentIpfs`). `CommentUpdate` records are re-signed by the community on every update cycle, so old wire format is naturally replaced — no need to support parsing old `CommentUpdate` records with the `subplebbit` key.

**Completed follow-up after the `author.address` migration:**
- [x] Remove `overrideAuthorAddressIfInvalid` from public verifier APIs.
- [x] Runtime behavior:
  - Keep `author.address = author.name || author.publicKey`
  - Never mutate runtime `author.address` based on failed or mismatched name resolution
  - Add runtime-only `author.nameResolved?: boolean`
  - Set `author.nameResolved = false` when a claimed `author.name` fails to resolve or resolves to a signer mismatch
  - Set `author.nameResolved = true` when a claimed `author.name` resolves to the signer
  - Leave `author.nameResolved` as `undefined` when there is no `author.name` claim
- [x] RPC `challengeverification` event wraps `nameResolved` in a separate wrapper object (not injected into the pubsub message type)

### 8.4 Timeout Keys (src/pkc/pkc.ts)
- [x] `"subplebbit-ipns"` → `"community-ipns"`
- [x] `"subplebbit-ipfs"` → `"community-ipfs"`

### 8.5 State Machine States (Public API - affects downstream consumers)
State strings emitted via `statechange` and `publishingstatechange` events:
- [x] `"resolving-subplebbit-address"` → `"resolving-community-name"` (src/publications/types.ts, src/publications/comment/types.ts)
- [x] `"fetching-subplebbit-ipns"` → `"fetching-community-ipns"`
- [x] `"fetching-subplebbit-ipfs"` → `"fetching-community-ipfs"`
- [x] Chain provider state: `"resolving-subplebbit-address"` → `"resolving-community-address"` (src/clients/chain-provider-client.ts)

**Note:** The codebase has a two-level state system. The **internal** `SubplebbitUpdatingState` (in `src/subplebbit/types.ts`) uses `"resolving-address"` (no entity prefix) and stays unchanged. The **external** client-facing states listed above (mapped in `rpc-remote-subplebbit.ts` and `publication-client-manager.ts`) are the ones that get renamed. Do not rename the internal `"resolving-address"` state.

---

## Phase 9: RPC Method Renaming

### 9.1 RPC Server Methods (src/rpc/src/index.ts)
- [x] `getSubplebbitPage` → `getCommunityPage`
- [x] `createSubplebbit` → `createCommunity`
- [x] `startSubplebbit` → `startCommunity`
- [x] `stopSubplebbit` → `stopCommunity`
- [x] `editSubplebbit` → `editCommunity`
- [x] `deleteSubplebbit` → `deleteCommunity`
- [x] `subplebbitsSubscribe` → `communitiesSubscribe`
- [x] `subplebbitUpdateSubscribe` → `communityUpdateSubscribe`
- [x] `publishSubplebbitEdit` → `publishCommunityEdit`
- [x] `resolveAuthorAddress` → `resolveAuthorName` (already renamed in both RPC server `src/rpc/src/index.ts:201` and client `src/clients/rpc-client/plebbit-rpc-client.ts:434`)

### 9.2 RPC Event Names
- [x] `"subplebbitschange"` → `"communitieschange"`
- [x] `"subplebbitUpdateNotification"` → `"communityUpdateNotification"`
- [x] `"subplebbitsNotification"` → `"communitiesNotification"`
- [x] `"publishSubplebbitEditNotification"` → `"publishCommunityEditNotification"`

### 9.3 RPC Parameter Names (Wire Protocol)
- [x] `RpcSubplebbitPageParamSchema.subplebbitAddress` → `communityAddress` (src/clients/rpc-client/schema.ts)
- [x] `getSubplebbitPage` params: `{ subplebbitAddress }` → `{ communityAddress }` (src/rpc/src/index.ts)
- [x] `getCommentPage` params: `{ subplebbitAddress }` → `{ communityAddress }` (src/rpc/src/index.ts)

### 9.4 RPC Name Resolution (Server-Side)
- [x] `getCommunity` / `communityUpdateSubscribe` RPC methods must accept domain names — name resolution happens server-side using the RPC server's registered `nameResolvers`
- [x] Add error response when server-side name resolution fails (`ERR_NAME_RESOLUTION_FAILED`)
- [x] RPC clients don't need `nameResolvers` config — they delegate resolution to the server

---

## Phase 10: Error Messages & Logging

### 10.1 Error Classes (src/plebbit-error.ts → src/pkc-error.ts)
- [x] `PlebbitError` → `PKCError`
- [x] `FailedToFetchSubplebbitFromGatewaysError` → `FailedToFetchCommunityFromGatewaysError`
- [x] `FailedToFetchCommentIpfsFromGatewaysError` (keep as is - comment not community)
- [x] `FailedToFetchCommentUpdateFromGatewaysError` (keep as is)
- [x] `FailedToFetchPageIpfsFromGatewaysError` (keep as is)
- [x] `FailedToFetchGenericIpfsFromGatewaysError` (keep as is)

### 10.2 Error Codes (src/errors.ts)

**SUBPLEBBIT → COMMUNITY error codes:**
- [x] `ERR_SUB_SIGNER_NOT_DEFINED` → `ERR_COMMUNITY_SIGNER_NOT_DEFINED`
- [x] `ERR_SUB_CAN_EITHER_RUN_OR_UPDATE` → `ERR_COMMUNITY_CAN_EITHER_RUN_OR_UPDATE`
- [x] `ERR_SUBPLEBBIT_MISSING_FIELD` → `ERR_COMMUNITY_MISSING_FIELD`
- [x] `ERR_SUBPLEBBIT_OPTIONS_MISSING_ADDRESS` → `ERR_COMMUNITY_OPTIONS_MISSING_ADDRESS`
- [x] `ERR_INVALID_SUBPLEBBIT_ADDRESS_SCHEMA` → `ERR_INVALID_COMMUNITY_ADDRESS_SCHEMA`
- [x] `ERR_SUB_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS` → `ERR_COMMUNITY_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS`
- [x] `ERR_COMMENT_IPFS_SUBPLEBBIT_ADDRESS_MISMATCH` → `ERR_COMMENT_IPFS_COMMUNITY_ADDRESS_MISMATCH`
- [x] `ERR_NEED_TO_STOP_UPDATING_SUB_BEFORE_STARTING` → `ERR_NEED_TO_STOP_UPDATING_COMMUNITY_BEFORE_STARTING`
- [x] `ERR_GET_SUBPLEBBIT_TIMED_OUT` → `ERR_GET_COMMUNITY_TIMED_OUT`
- [x] `ERR_CALLED_SUBPLEBBIT_STOP_WITHOUT_UPDATE` → `ERR_CALLED_COMMUNITY_STOP_WITHOUT_UPDATE`
- [x] `ERR_CAN_NOT_RUN_A_SUB_WITH_NO_IPFS_NODE` → `ERR_CAN_NOT_RUN_A_COMMUNITY_WITH_NO_IPFS_NODE`
- [x] `ERR_CAN_NOT_CREATE_A_LOCAL_SUB` → `ERR_CAN_NOT_CREATE_A_LOCAL_COMMUNITY`
- [x] `ERR_SUB_ADDRESS_IS_PROVIDED_AS_NULL_OR_UNDEFINED` → `ERR_COMMUNITY_ADDRESS_IS_PROVIDED_AS_NULL_OR_UNDEFINED`
- [x] `ERR_UNABLE_TO_DERIVE_PUBSUB_SUBPLEBBIT_EDIT_PUBLICATION_FROM_JSONIFIED_SUBPLEBBIT_EDIT` → `ERR_UNABLE_TO_DERIVE_PUBSUB_COMMUNITY_EDIT_PUBLICATION_FROM_JSONIFIED_COMMUNITY_EDIT`
- [x] `ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS` → `ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS`
- [x] `ERR_SUBPLEBBIT_HAS_NO_POST_UPDATES` → `ERR_COMMUNITY_HAS_NO_POST_UPDATES`
- [x] `ERR_GATEWAY_ABORTING_LOADING_SUB_BECAUSE_SAME_INVALID_SUBPLEBBIT_RECORD` → `ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_SAME_INVALID_COMMUNITY_RECORD`
- [x] `ERR_GATEWAY_ABORTING_LOADING_SUB_BECAUSE_SAME_UPDATE_CID` → `ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_SAME_UPDATE_CID`
- [x] `ERR_GATEWAY_ABORTING_LOADING_SUB_BECAUSE_WE_ALREADY_LOADED_THIS_RECORD` → `ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_WE_ALREADY_LOADED_THIS_RECORD`
- [x] `ERR_REMOTE_SUBPLEBBIT_RECEIVED_ALREADY_PROCCESSED_RECORD` → `ERR_REMOTE_COMMUNITY_RECEIVED_ALREADY_PROCCESSED_RECORD`
- [x] `ERR_INVALID_SUBPLEBBIT_IPFS_SCHEMA` → `ERR_INVALID_COMMUNITY_IPFS_SCHEMA`
- [x] `ERR_INVALID_RPC_LOCAL_SUBPLEBBIT_UPDATE_SCHEMA` → `ERR_INVALID_RPC_LOCAL_COMMUNITY_UPDATE_SCHEMA`
- [x] `ERR_INVALID_RPC_SUBPLEBBIT_UPDATING_STATE_SCHEMA` → `ERR_INVALID_RPC_COMMUNITY_UPDATING_STATE_SCHEMA`
- [x] `ERR_INVALID_RPC_SUBPLEBBIT_STARTED_STATE_SCHEMA` → `ERR_INVALID_RPC_COMMUNITY_STARTED_STATE_SCHEMA`
- [x] `ERR_INVALID_RPC_ENCODED_CHALLENGE_REQUEST_WITH_SUBPLEBBIT_AUTHOR_PUBSUB_MSG_SCHEMA` → `ERR_INVALID_RPC_ENCODED_CHALLENGE_REQUEST_WITH_COMMUNITY_AUTHOR_PUBSUB_MSG_SCHEMA`
- [x] `ERR_INVALID_RPC_REMOTE_SUBPLEBBIT_SCHEMA` → `ERR_INVALID_RPC_REMOTE_COMMUNITY_SCHEMA`
- [x] `ERR_LOCAL_SUBPLEBIT_PRODUCED_INVALID_SCHEMA` → `ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SCHEMA`
- [x] `ERR_INVALID_CREATE_SUBPLEBBIT_ARGS_SCHEMA` → `ERR_INVALID_CREATE_COMMUNITY_ARGS_SCHEMA`
- [x] `ERR_INVALID_CREATE_REMOTE_SUBPLEBBIT_ARGS_SCHEMA` → `ERR_INVALID_CREATE_REMOTE_COMMUNITY_ARGS_SCHEMA`
- [x] `ERR_INVALID_CREATE_SUBPLEBBIT_EDIT_ARGS_SCHEMA` → `ERR_INVALID_CREATE_COMMUNITY_EDIT_ARGS_SCHEMA`
- [x] `ERR_INVALID_CREATE_NEW_LOCAL_SUB_USER_OPTIONS` → `ERR_INVALID_CREATE_NEW_LOCAL_COMMUNITY_USER_OPTIONS`
- [x] `ERR_INVALID_SUBPLEBBIT_EDIT_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA` → `ERR_INVALID_COMMUNITY_EDIT_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA`
- [x] `ERR_SUBPLEBBIT_EDIT_OPTIONS_SCHEMA` → `ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA`
- [x] `ERR_INVALID_CREATE_SUBPLEBBIT_WITH_RPC_ARGS_SCHEMA` → `ERR_INVALID_CREATE_COMMUNITY_WITH_RPC_ARGS_SCHEMA`
- [x] `ERR_CAN_NOT_SET_EXCLUDE_PUBLICATION_TO_EMPTY_OBJECT` → (keep as is - no subplebbit in name)
- [x] `ERR_SUB_HAS_NO_INTERNAL_STATE` → `ERR_COMMUNITY_HAS_NO_INTERNAL_STATE`
- [x] `ERR_THE_SUBPLEBBIT_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED` → `ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED`
- [x] `ERR_SUBPLEBBIT_IPNS_NAME_DOES_NOT_MATCH_SIGNATURE_PUBLIC_KEY` → `ERR_COMMUNITY_IPNS_NAME_DOES_NOT_MATCH_SIGNATURE_PUBLIC_KEY`
- [x] `ERR_COMMENT_UPDATE_IS_NOT_SIGNED_BY_SUBPLEBBIT` → `ERR_COMMENT_UPDATE_IS_NOT_SIGNED_BY_COMMUNITY`
- [x] `ERR_CHALLENGE_MSG_SIGNER_IS_NOT_SUBPLEBBIT` → `ERR_CHALLENGE_MSG_SIGNER_IS_NOT_COMMUNITY`
- [x] `ERR_CHALLENGE_VERIFICATION_MSG_SIGNER_IS_NOT_SUBPLEBBIT` → `ERR_CHALLENGE_VERIFICATION_MSG_SIGNER_IS_NOT_COMMUNITY`
- [x] `ERR_LOCAL_SUBPLEBBIT_PRODUCED_INVALID_SIGNATURE` → `ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SIGNATURE`
- [x] `ERR_SUBPLEBBIT_POSTS_INVALID` → `ERR_COMMUNITY_POSTS_INVALID`
- [x] `ERR_SUBPLEBBIT_EDIT_HAS_RESERVED_FIELD` → `ERR_COMMUNITY_EDIT_HAS_RESERVED_FIELD`
- [x] `ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID` → `ERR_COMMUNITY_SIGNATURE_IS_INVALID`
- [x] `ERR_SUBPLEBBIT_RECORD_INCLUDES_RESERVED_FIELD` → `ERR_COMMUNITY_RECORD_INCLUDES_RESERVED_FIELD`
- [x] `ERR_FAILED_TO_RESOLVE_SUBPLEBBIT_DOMAIN` → `ERR_FAILED_TO_RESOLVE_COMMUNITY_DOMAIN`
- [x] `ERR_DOMAIN_ADDRESS_HAS_CAPITAL_LETTER` → `ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER`
- [x] `ERR_SUBPLEBBIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES` → `ERR_COMMUNITY_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES`
- [x] `ERR_SUBPLEBBIT_EDIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES` → `ERR_COMMUNITY_EDIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES`
- [x] `ERR_SUB_CHANGED_COMMENT_PUBSUB_PUBLICATION_PROPS` → `ERR_COMMUNITY_CHANGED_COMMENT_PUBSUB_PUBLICATION_PROPS`
- [x] `ERR_SUB_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENT` → `ERR_COMMUNITY_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENT`
- [x] `ERR_SUB_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENTUPDATE` → `ERR_COMMUNITY_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENTUPDATE`
- [x] `ERR_SUB_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_CID` → `ERR_COMMUNITY_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_CID`
- [x] `ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_SUB` → `ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY`
- [x] `ERR_DOMAIN_SUB_ADDRESS_TXT_RECORD_POINT_TO_DIFFERENT_ADDRESS` → `ERR_DOMAIN_COMMUNITY_ADDRESS_TXT_RECORD_POINT_TO_DIFFERENT_ADDRESS`
- [x] `ERR_SUBPLEBBIT_DOMAIN_HAS_NO_TEXT_RECORD` → `ERR_COMMUNITY_DOMAIN_HAS_NO_TEXT_RECORD`
- [x] `ERR_LOCAL_SUB_HAS_NO_SIGNER_IN_INTERNAL_STATE` → `ERR_LOCAL_COMMUNITY_HAS_NO_SIGNER_IN_INTERNAL_STATE`
- [x] `ERR_SUB_STATE_LOCKED` → `ERR_COMMUNITY_STATE_LOCKED`
- [x] `ERR_SUB_CREATION_LOCKED` → `ERR_COMMUNITY_CREATION_LOCKED`
- [x] `ERR_SUB_ALREADY_STARTED` → `ERR_COMMUNITY_ALREADY_STARTED`
- [x] `ERR_LOCAL_SUBPLEBBIT_PRODUCED_INVALID_RECORD` → `ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_RECORD`
- [x] `ERR_LOCAL_SUBPLEBBIT_RECORD_TOO_LARGE` → `ERR_LOCAL_COMMUNITY_RECORD_TOO_LARGE`
- [x] `ERR_CAN_NOT_LOAD_DB_IF_LOCAL_SUB_ALREADY_STARTED_IN_ANOTHER_PROCESS` → `ERR_CAN_NOT_LOAD_DB_IF_LOCAL_COMMUNITY_ALREADY_STARTED_IN_ANOTHER_PROCESS`
- [x] `ERR_CAN_NOT_EDIT_A_LOCAL_SUBPLEBBIT_THAT_IS_ALREADY_STARTED_IN_ANOTHER_PROCESS` → `ERR_CAN_NOT_EDIT_A_LOCAL_COMMUNITY_THAT_IS_ALREADY_STARTED_IN_ANOTHER_PROCESS`
- [x] `CAN_NOT_LOAD_LOCAL_SUBPLEBBIT_IF_DB_DOES_NOT_EXIST` → `CAN_NOT_LOAD_LOCAL_COMMUNITY_IF_DB_DOES_NOT_EXIST`
- [x] `ERR_SUB_START_FAILED_UNKNOWN_ERROR` → `ERR_COMMUNITY_START_FAILED_UNKNOWN_ERROR`
- [x] `ERR_SUB_ALREADY_STARTED_IN_SAME_PLEBBIT_INSTANCE` → `ERR_COMMUNITY_ALREADY_STARTED_IN_SAME_PKC_INSTANCE`
- [x] `ERR_SUB_COMMENT_TIMESTAMP_IS_EARLIER_THAN_PARENT` → `ERR_COMMUNITY_COMMENT_TIMESTAMP_IS_EARLIER_THAN_PARENT`
- [x] `ERR_SUB_PUBLICATION_PARENT_CID_NOT_DEFINED` → `ERR_COMMUNITY_PUBLICATION_PARENT_CID_NOT_DEFINED`
- [x] `ERR_PUBLICATION_INVALID_SUBPLEBBIT_ADDRESS` → `ERR_PUBLICATION_INVALID_COMMUNITY_ADDRESS`
- [x] `ERR_SUB_PUBLICATION_PARENT_HAS_BEEN_REMOVED` → `ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_REMOVED`
- [x] `ERR_SUB_PUBLICATION_PARENT_HAS_BEEN_DELETED` → `ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_DELETED`
- [x] `ERR_SUB_PUBLICATION_POST_HAS_BEEN_DELETED` → `ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_DELETED`
- [x] `ERR_SUB_PUBLICATION_POST_HAS_BEEN_REMOVED` → `ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_REMOVED`
- [x] `ERR_SUB_PUBLICATION_POST_IS_LOCKED` → `ERR_COMMUNITY_PUBLICATION_POST_IS_LOCKED`
- [x] `ERR_SUB_FAILED_TO_DECRYPT_PUBSUB_MSG` → `ERR_COMMUNITY_FAILED_TO_DECRYPT_PUBSUB_MSG`
- [x] `ERR_SUB_COMMENT_MOD_CAN_NOT_LOCK_REPLY` → `ERR_COMMUNITY_COMMENT_MOD_CAN_NOT_LOCK_REPLY`
- [x] `ERR_SUB_COMMENT_EDIT_UNAUTHORIZED_FIELD` → `ERR_COMMUNITY_COMMENT_EDIT_UNAUTHORIZED_FIELD`
- [x] `ERR_SUBPLEBBIT_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS` → `ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS`
- [x] `ERR_SUBPLEBBIT_EDIT_ATTEMPTED_TO_MODIFY_SUB_WITHOUT_BEING_OWNER_OR_ADMIN` → `ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_COMMUNITY_WITHOUT_BEING_OWNER_OR_ADMIN`
- [x] `ERR_SUBPLEBBIT_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS` → `ERR_COMMUNITY_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS`
- [x] `ERR_RPC_CLIENT_ATTEMPTING_TO_START_A_REMOTE_SUB` → `ERR_RPC_CLIENT_ATTEMPTING_TO_START_A_REMOTE_COMMUNITY`
- [x] `ERR_RPC_CLIENT_TRYING_TO_STOP_SUB_THAT_IS_NOT_RUNNING` → `ERR_RPC_CLIENT_TRYING_TO_STOP_COMMUNITY_THAT_IS_NOT_RUNNING`
- [x] `ERR_RPC_CLIENT_TRYING_TO_STOP_REMOTE_SUB` → `ERR_RPC_CLIENT_TRYING_TO_STOP_REMOTE_COMMUNITY`
- [x] `ERR_RPC_CLIENT_TRYING_TO_EDIT_REMOTE_SUB` → `ERR_RPC_CLIENT_TRYING_TO_EDIT_REMOTE_COMMUNITY`
- [x] `ERR_RPC_CLIENT_TRYING_TO_DELETE_REMOTE_SUB` → `ERR_RPC_CLIENT_TRYING_TO_DELETE_REMOTE_COMMUNITY`

**PLEBBIT → PKC error codes:**
- [x] `ERR_PLEBBIT_MISSING_NATIVE_FUNCTIONS` → `ERR_PKC_MISSING_NATIVE_FUNCTIONS`
- [x] `ERR_PLEBBIT_OPTION_NOT_ACCEPTED` → `ERR_PKC_OPTION_NOT_ACCEPTED`
- [x] `ERR_PLEBBIT_SQLITE_LONG_TERM_STORAGE_KEYV_ERROR` → `ERR_PKC_SQLITE_LONG_TERM_STORAGE_KEYV_ERROR`
- [x] `ERR_PLEBBIT_IS_DESTROYED` → `ERR_PKC_IS_DESTROYED`
- [x] `ERR_INVALID_CREATE_PLEBBIT_WS_SERVER_OPTIONS_SCHEMA` → `ERR_INVALID_CREATE_PKC_WS_SERVER_OPTIONS_SCHEMA`
- [x] `ERR_INVALID_CREATE_PLEBBIT_ARGS_SCHEMA` → `ERR_INVALID_CREATE_PKC_ARGS_SCHEMA`

### 10.3 Index Exports (src/index.ts)
- [x] `plebbitJsChallenges` export → `pkcJsChallenges`

### 10.4 Logger Prefixes
~~Replace all logger prefixes:~~
- [x] `Logger("plebbit-js:...")` → `Logger("pkc-js:...")` (48+ prefixes across src/) — All Logger call sites now use the correct `pkc-js:` namespaces directly. The runtime namespace replacement layer in `src/logger.ts` was removed (`309d8fe65`) after all call sites were updated. Logger calls referencing "sub" were renamed to "community" in `d11432c0a`.
- [x] `Logger("plebbit-js-rpc:...")` → `Logger("pkc-js-rpc:...")` — All call sites updated directly
- [x] CI workflows and VSCode debug configurations updated for new namespace scheme (`DEBUG` filters now use `pkc-js*` and `pkc-js-rpc*`)

---

## Phase 11: Signer & Signature Functions

### 11.1 Function Names (src/signer/signatures.ts)
- [x] `signSubplebbitEdit` → `signCommunityEdit`
- [x] `verifySubplebbitEdit` → `verifyCommunityEdit`
- [x] `verifySubplebbit` → `verifyCommunity`
- [x] `signSubplebbit` → `signCommunity`

### 11.2 Type Parameters
- [x] All function parameters with `plebbit: Plebbit` → `pkc: PKC`
- [x] All `subplebbit` parameters → `community`

---

## Phase 12: Test Files

### 12.1 Test File Renaming
Rename all test files with "subplebbit" or "plebbit" in the name. Files without "subplebbit"/"plebbit" in the filename only need content updates (Phase 12.2), not file renaming — they are listed for completeness under their directory.

**test/node/subplebbit/** (34 files — directory moves to test/node/community/)
- [x] `create.subplebbit.test.ts` → `create.community.test.ts`
- [x] `delete.subplebbit.test.ts` → `delete.community.test.ts`
- [x] `edit.subplebbit.test.ts` → `edit.community.test.ts`
- [x] `start.subplebbit.test.ts` → `start.community.test.ts`
- [x] `stop.subplebbit.test.ts` → `stop.community.test.ts`
- [x] `state.subplebbit.test.ts` → `state.community.test.ts`
- [x] `update.subplebbit.test.ts` → `update.community.test.ts`
- [x] `editable.subplebbit.test.ts` → `editable.community.test.ts`
- [x] `error.start.subplebbit.test.ts` → `error.start.community.test.ts`
- [x] `local.publishing.subplebbit.test.ts` → `local.publishing.community.test.ts`
- [x] `misc.subplebbit.test.ts` → `misc.community.test.ts`
- [x] `updateCid.subplebbit.test.ts` → `updateCid.community.test.ts`
- [x] `unique.migration.db.subplebbit.test.ts` → `unique.migration.db.community.test.ts`
- [x] `db.subplebbit.test.ts` → `db.community.test.ts`
- [x] `commentsToUpdate.db.subplebbit.test.ts` → `commentsToUpdate.db.community.test.ts`
- [x] `parsing.db.subplebbit.test.ts` → `parsing.db.community.test.ts`
- [x] `authorPublicationCounts.db.subplebbit.test.ts` → `authorPublicationCounts.db.community.test.ts`
- [x] `queryComment.quotedCids.db.subplebbit.test.ts` → `queryComment.quotedCids.db.community.test.ts`
- [x] `startedState.subplebbit.test.ts` → `startedState.community.test.ts`
- [x] `stats.subplebbit.test.ts` → `stats.community.test.ts`
- [x] `updatingstate.subplebbit.test.ts` → `updatingstate.community.test.ts`
- [x] `republishing.subplebbit.test.ts` → `republishing.community.test.ts`
- [x] `postUpdates.subplebbit.test.ts` → `postUpdates.community.test.ts`
- [x] `gateway.loading.subplebbit.test.ts` → `gateway.loading.community.test.ts`
- [x] `commentUpdate.fields.db.subplebbit.test.ts` → `commentUpdate.fields.db.community.test.ts`
- [x] `unique.publishing.subplebbit.test.ts` → `unique.publishing.community.test.ts`
- [x] `garbage.collection.subplebbit.test.ts` → `garbage.collection.community.test.ts`
- [x] `quotedCids.pendingApproval.subplebbit.test.ts` → `quotedCids.pendingApproval.community.test.ts`
- [x] `eth-bso-equivalence.test.ts` (content updates only — no "subplebbit" in filename)
- [x] `malformed-gateway-headers.test.ts` (content updates only)
- [x] `maximum.depth.test.ts` (content updates only)
- [x] `mirror-client-mismatch.test.ts` (content updates only)
- [x] `multiplegateways.update.test.ts` (content updates only)
- [x] `unsupported-tld-rejection.test.ts` (content updates only)
- [x] `runtime-author-fields.db.subplebbit.test.ts` → `runtime-author-fields.db.community.test.ts`

**test/node/subplebbit/ipns/**
- [x] `resolve.ipns.subplebbit.test.ts` → `resolve.ipns.community.test.ts`

**test/node/subplebbit/modqueue/**
- [x] `modqueue.subplebbit.test.ts` → `modqueue.community.test.ts`
- [x] `purge.expire.rejection.modqueue.subplebbit.test.ts` → `purge.expire.rejection.modqueue.community.test.ts`
- [x] `approved.modqueue.subplebbit.test.ts` → `approved.modqueue.community.test.ts`
- [x] `limit.modqueue.subplebbit.test.ts` → `limit.modqueue.community.test.ts`
- [x] `page.modqueue.subplebbit.test.ts` → `page.modqueue.community.test.ts`
- [x] `pendingapproval.modqueue.subplebbit.test.ts` → `pendingapproval.modqueue.community.test.ts`
- [x] `rejection.modqueue.subplebbit.test.ts` → `rejection.modqueue.community.test.ts`

**test/node/subplebbit/page-generation/**
- [x] `chunking.page.generation.subplebbit.test.ts` → `chunking.page.generation.community.test.ts`
- [x] `edgecases.page.generation.subplebbit.test.ts` → `edgecases.page.generation.community.test.ts`

**test/node/subplebbit/challenges/** (directory moves to test/node/community/challenges/)
- [x] `challenges.settings.test.ts` (content updates only)
- [x] `path.challenge.test.ts` (content updates only)
- [x] `pseudonymity-challenge-exclusion.test.ts` (content updates only)

**test/node/subplebbit/pubsub-msgs/** (directory moves to test/node/community/pubsub-msgs/)
- [x] `properties.pubsub.test.ts` (content updates only)

**test/node/subplebbit/features/** (31 files — directory moves to test/node/community/features/)
- [x] `per-post.pseudonymityMode.subplebbit.features.test.ts` → `per-post.pseudonymityMode.community.features.test.ts`
- [x] `per-reply.pseudonymityMode.subplebbit.features.test.ts` → `per-reply.pseudonymityMode.community.features.test.ts`
- [x] `per-author.pseudonymityMode.subplebbit.features.test.ts` → `per-author.pseudonymityMode.community.features.test.ts`
- [x] `authorFlairs.subplebbit.features.test.ts` → `authorFlairs.community.features.test.ts`
- [x] `noAudio.subplebbit.features.test.ts` → `noAudio.community.features.test.ts`
- [x] `noAudioReplies.subplebbit.features.test.ts` → `noAudioReplies.community.features.test.ts`
- [x] `noDownvotes.subplebbit.features.test.ts` → `noDownvotes.community.features.test.ts`
- [x] `noImages.subplebbit.features.test.ts` → `noImages.community.features.test.ts`
- [x] `noImageReplies.subplebbit.features.test.ts` → `noImageReplies.community.features.test.ts`
- [x] `noMarkdownAudio.subplebbit.features.test.ts` → `noMarkdownAudio.community.features.test.ts`
- [x] `noMarkdownImages.subplebbit.features.test.ts` → `noMarkdownImages.community.features.test.ts`
- [x] `noMarkdownVideos.subplebbit.features.test.ts` → `noMarkdownVideos.community.features.test.ts`
- [x] `noNestedReplies.subplebbit.features.test.ts` → `noNestedReplies.community.features.test.ts`
- [x] `noPostDownvotes.subplebbit.features.test.ts` → `noPostDownvotes.community.features.test.ts`
- [x] `noPostUpvotes.subplebbit.features.test.ts` → `noPostUpvotes.community.features.test.ts`
- [x] `noReplyDownvotes.subplebbit.features.test.ts` → `noReplyDownvotes.community.features.test.ts`
- [x] `noReplyUpvotes.subplebbit.features.test.ts` → `noReplyUpvotes.community.features.test.ts`
- [x] `noSpoilers.subplebbit.features.test.ts` → `noSpoilers.community.features.test.ts`
- [x] `noSpoilerReplies.subplebbit.features.test.ts` → `noSpoilerReplies.community.features.test.ts`
- [x] `noUpvotes.subplebbit.features.test.ts` → `noUpvotes.community.features.test.ts`
- [x] `noVideos.subplebbit.features.test.ts` → `noVideos.community.features.test.ts`
- [x] `noVideoReplies.subplebbit.features.test.ts` → `noVideoReplies.community.features.test.ts`
- [x] `postFlairs.subplebbit.features.test.ts` → `postFlairs.community.features.test.ts`
- [x] `requireAuthorFlairs.subplebbit.features.test.ts` → `requireAuthorFlairs.community.features.test.ts`
- [x] `requirePostFlairs.subplebbit.features.test.ts` → `requirePostFlairs.community.features.test.ts`
- [x] `requirePostLink.subplebbit.features.test.ts` → `requirePostLink.community.features.test.ts`
- [x] `requirePostLinkIsMedia.subplebbit.features.test.ts` → `requirePostLinkIsMedia.community.features.test.ts`
- [x] `requireReplyLink.subplebbit.features.test.ts` → `requireReplyLink.community.features.test.ts`
- [x] `requireReplyLinkIsMedia.subplebbit.features.test.ts` → `requireReplyLinkIsMedia.community.features.test.ts`
- [x] `safeForWork.subplebbit.features.test.ts` → `safeForWork.community.features.test.ts`

**test/node/plebbit/** (directory to be renamed to test/node/pkc/)
- [x] `plebbit.test.ts` → `pkc.test.ts`
- [x] `validatecomment.plebbit.test.ts` → `validatecomment.pkc.test.ts`
- [x] `started-subplebbits.test.ts` → `started-communities.test.ts`
- [x] `plebbit-settings-challenges.test.ts` → `pkc-settings-challenges.test.ts`
- [x] `plebbit-settings-challenges-rpc.test.ts` → `pkc-settings-challenges-rpc.test.ts`
- [x] `hanging.plebbit.test.ts` → `hanging.pkc.test.ts`
- [x] `plebbit-settings-nameresolvers-rpc.test.ts` → `pkc-settings-nameresolvers-rpc.test.ts`
- [x] `getsubplebbit.publickey-fallback-rpc.test.ts` → `getcommunity.publickey-fallback-rpc.test.ts`

**test/node/** (root-level test files)
- [x] `logger.namespace.test.ts` (content updates only)

**test/node/pages/**
- [x] `author-subplebbit-in-pages.test.ts` → `author-community-in-pages.test.ts`

**test/node-and-browser/subplebbit/** (15 files — directory moves to test/node-and-browser/community/)
- [x] `state.subplebbit.test.ts` → `state.community.test.ts`
- [x] `getsubplebbit.publickey-fallback.test.ts` → `getcommunity.publickey-fallback.test.ts`
- [x] `backward.compatibility.subplebbit.test.ts` → `backward.compatibility.community.test.ts`
- [x] `updateCid.subplebbit.test.ts` → `updateCid.community.test.ts`
- [x] `getsubplebbit.plebbit.test.ts` → `getcommunity.pkc.test.ts`
- [x] `createsubplebbit.plebbit.test.ts` → `createcommunity.pkc.test.ts`
- [x] `update.subplebbit.test.ts` → `update.community.test.ts`
- [x] `stop.subplebbit.test.ts` → `stop.community.test.ts`
- [x] `ipfsgateways.clients.test.ts` (content updates only)
- [x] `libp2pjs.kuboRpc.clients.test.ts` (content updates only)
- [x] `nameresolvers.clients.test.ts` (content updates only)
- [x] `rpc.clients.test.ts` (content updates only)
- [x] `updatingstate.test.ts` (content updates only)
- [x] `waiting-retry.update.test.ts` (content updates only)

**test/node-and-browser/subplebbit/ipns/**
- [x] `ipns.fields.subplebbit.test.ts` → `ipns.fields.community.test.ts`

**test/node-and-browser/subplebbit/posts/** (directory moves to test/node-and-browser/community/posts/)
- [x] `pages.posts.test.ts` (content updates only)
- [x] `ipfsgateways.clients.posts.test.ts` (content updates only)
- [x] `rpc.clients.posts.test.ts` (content updates only)
- [x] `libp2pjs.kuboRpc.clients.posts.test.ts` (content updates only)

**test/node-and-browser/subplebbit/modqueue/** (directory moves to test/node-and-browser/community/modqueue/)
- [x] `pages.modqueue.test.ts` (content updates only)
- [x] `ipfsgateways.clients.modqueue.test.ts` (content updates only)
- [x] `rpc.clients.modqueue.test.ts` (content updates only)
- [x] `libp2pjs.kuboRpc.clients.modqueue.test.ts` (content updates only)

**test/node-and-browser/plebbit/** (directory to be renamed to test/node-and-browser/pkc/)
- [x] `plebbit.test.ts` → `pkc.test.ts`
- [x] `_updatingSubplebbits.plebbit.test.ts` → `_updatingCommunities.pkc.test.ts`
- [x] `_updatingComments.plebbit.test.ts` → `_updatingComments.pkc.test.ts`
- [x] `fetchCid.plebbit.test.ts` → `fetchCid.pkc.test.ts`
- [x] `test.configs.plebbit.test.ts` → `test.configs.pkc.test.ts`
- [x] `tracked-instance-registry.test.ts` (content updates only)

**test/node-and-browser/signatures/**
- [x] `subplebbit.test.ts` → `community.test.ts`
- [x] `pubsub.messages.test.ts` (content updates only)
- [x] `comment.test.ts` (content updates only)
- [x] `edit.comment.test.ts` (content updates only)
- [x] `vote.test.ts` (content updates only)
- [x] `pages.test.ts` (content updates only)

**test/node-and-browser/publications/subplebbit-edit/** (directory moves to test/node-and-browser/publications/community-edit/)
- [x] `subplebbit.edit.publication.test.ts` → `community.edit.publication.test.ts`

**test/node-and-browser/publications/**
- [x] `author-address-domain-normalization.test.ts` (content updates only)
- [x] `runtime-author-fields-serialization.test.ts` (content updates only)
- [x] `community-publickey-fallback.publish.test.ts` (content updates only — already uses new naming convention)

**test/node-and-browser/publications/comment/**
- [x] `getcomment.plebbit.test.ts` → `getcomment.pkc.test.ts`

**test/node-and-browser/** (root-level test files)
- [x] `deep-merge-runtime-fields.test.ts` (content updates only)

**test/browser/**
- [x] `plebbit.test.ts` → `pkc.test.ts`

**test/server/**
- [x] `plebbit-ws-server.js` → `pkc-ws-server.js`

### 12.2 Test Content Updates
- [x] Update all test imports to use new module paths
- [x] Update all test assertions referencing old names
- [x] Update fixture references

### 12.3 Test Fixtures (test/fixtures/)
- [x] `test/fixtures/signatures/subplebbit/` → `test/fixtures/signatures/community/`
- [x] Update JSON fixture files:
  - `valid_subplebbit_ipfs.json` → `valid_community_ipfs.json` (old duplicates deleted, new-named copies already existed)
  - `valid_subplebbit_jsonfied.json` → `valid_community_jsonfied.json` (old duplicates deleted, new-named copies already existed)
  - `valid_page_legacy_subplebbitAddress.json` → `valid_page_legacy_communityAddress.json`
  - Note: JSON content within fixtures intentionally kept (wire-format backward-compat data)

### 12.4 Test Configuration
- [x] `test/run-test-config.js` - Update PLEBBIT_CONFIGS → PKC_CONFIGS (done in Phase 18)
- [x] Update environment variable references (done in Phase 18)

---

## Phase 13: DNS & Protocol Changes (Breaking)

### 13.1 DNS TXT Record Names
Remove hardcoded DNS TXT record lookups from pkc-js core. The `"bitsocial"` TXT record lookup is handled by `@bitsocial/bso-resolver`, not pkc-js.
- [x] Remove `"plebbit-author-address"` TXT record lookup from `src/clients/base-client-manager.ts`
- [x] Remove `"subplebbit-address"` TXT record lookup from `src/clients/base-client-manager.ts`
- [x] Remove `resolveSubplebbitAddressIfNeeded()` and `resolveAuthorAddressIfNeeded()` methods (renamed to `resolveCommunityNameIfNeeded()`/`resolveAuthorNameIfNeeded()` which delegate to `nameResolvers`)

### ~~13.2 Wallet Signature Domain Separator~~ (Removed)
~~The EVM contract call challenge uses a domain separator in the message to be signed.~~
Not applicable — the evm-contract-call challenge is being extracted to `@bitsocial/challenge-evm-contract` (see Phase 1). The domain separator rename is that package's responsibility.

### 13.3 Migration TODO
- [x] **IMPORTANT:** Need to migrate existing DNS TXT records from old names (`subplebbit-address`, `plebbit-author-address`) to single `bitsocial` record — this is documented by `@bitsocial/bso-resolver`, not pkc-js
- [x] Document migration process for users with existing records — documented in `docs/ens.md` (migration section)
- [x] Resolver plugins (e.g., `@bitsocial/bso-resolver`) may choose to support both old and new record names during transition period — noted in `docs/ens.md`; backward compat is a resolver-level decision

### 13.4 Storage Cache Keys
Domain resolution cache keys are removed from pkc-js core (resolution moves to external resolvers):
- [x] Remove domain resolution cache logic from `src/clients/base-client-manager.ts` (cache keys like `${domainAddress}_subplebbit-address`) — resolvers now manage their own caching via optional `dataPath` field in `NameResolverSchema`

---

## Phase 14: Data Migration Code

### 14.1 Storage Path Migration
- [x] Change default `dataPath` from `~/.plebbit/` to `~/.pkc/` in pkc-js — `getDefaultDataPath()` in `src/runtime/node/util.ts` returns `.pkc`
- [x] Document that `subplebbits/` → `communities/` directory rename is needed — documented in `docs/protocol/data-path-migration.md`
- [x] Document that `.plebbit/` → `.pkc/` directory rename is needed — documented in `docs/protocol/data-path-migration.md`
- [x] Note: Actual migration of existing directories should be implemented in plebbit-cli and desktop apps, NOT in pkc-js
- [x] Create migration documentation for downstream applications — `docs/protocol/data-path-migration.md`

### 14.2 DNS Record Migration
- [x] Document process for migrating DNS TXT records — documented in `docs/ens.md`
- [x] Consider adding temporary support for both old and new record names — this is a resolver-level concern (noted in `docs/ens.md`); pkc-js core does not perform DNS lookups

### 14.3 Database Schema Migration
*Completed as Phase 1B Step 3 — see that section for details.*
- [x] Add `communityPublicKey` and `communityName` columns to publication tables
- [x] `subplebbitAddress` removed from tables entirely (preserved in `extraProps` for CID reconstruction)
- [x] DB_VERSION bumped to 37, migration logic added (backfill from `subplebbitAddress`)
- [x] Backfill `communityPublicKey` from `subplebbitAddress` for existing records (IPNS key → `communityPublicKey`; domain → `communityName`)
- [x] Migration tests in `test/node/community/v36-to-v37.migration.db.community.test.ts` (page queries, domain filtering, .bso↔.eth equivalence)
- [x] Comprehensive v29→v37 migration tests in `test/node/community/v29-production.migration.db.community.test.ts` (sampled from real production DB — diverse fields, CID reconstruction, page queries)
- [x] `queryComment()` returns proper values for new columns

### 14.4 External Applications Migration (IMPORTANT)
The following applications will need migration code to rename `subplebbits/` → `communities/` directory:
- [ ] **plebbit-cli** - Add directory rename migration on startup
- [ ] **Desktop apps** (electron apps, etc.) - Add directory rename migration
- [ ] Any other apps using plebbit-js data directory structure
- [ ] Document breaking change in release notes for downstream applications

---

## Phase 15: Documentation

### 15.1 docs/ Directory
Update all documentation files:
- [x] `docs/addresses.md`
- [x] `docs/building.md`
- [x] `docs/clients.md`
- [x] `docs/cross-platform-native-functions.md`
- [x] `docs/encryption.md` (no changes needed)
- [x] `docs/ens.md` (no changes needed; migration section kept as-is)
- [x] `docs/nft.md`
- [x] `docs/signatures.md` (no changes needed)
- [x] `docs/testing.md`
- [x] `docs/verifying-publications.md`

### 15.2 Domain Separator Rename
- [x] `"plebbit-author-avatar"` → `"pkc-author-avatar"` in `docs/nft.md` and `test/node-and-browser/publications/comment/publish/publish.verification.test.ts`

### 15.3 RPC Documentation
- [x] `src/rpc/README.md`
- [x] `src/rpc/EXPORT_SUBPLEBBIT_SPEC.md` deleted (duplicate of `EXPORT_COMMUNITY_SPEC.md`)

---

## Phase 16: GitHub & CI/CD

### 16.1 GitHub Workflows (.github/workflows/)
- [x] `CI.yml` - Updated all job names, env vars, config flags
- [x] `CI-build.yml` (no changes needed)
- [x] `CI-windows-test.yml`
- [x] `CI-alerts.yml`
- [x] `CI-plebbit-protocol-test.yml` → `CI-pkc-protocol-test.yml`
- [x] `CI-plebbit-react-hooks.yml` → `CI-pkc-react-hooks.yml`
- [x] `CI-plebbit-js-benchmarks.yml` → `CI-pkc-js-benchmarks.yml`

### 16.2 Repository Rename (External)
- [x] GitHub repository: `plebbit/plebbit-js` → `pkcprotocol/pkc-js`
- [x] Updated workflow URLs (benchmarks clone URL updated; protocol-test and react-hooks repos not yet moved)

---

## Phase 17: Build & Verification

### 17.1 Build Process
- [ ] Run `npm run build` and fix any compilation errors
- [ ] Verify browser build succeeds
- [ ] Verify Node build succeeds

### 17.2 Test Verification
- [ ] Run full test suite
- [ ] Fix any failing tests
- [ ] Update test expectations where needed

### 17.3 Type Checking
- [ ] Run `npm run typecheck:node`
- [ ] Run `npm run typecheck:browser`
- [ ] Fix any type errors

---

## Phase 18: Full plebbit/subplebbit Keyword Cleanup

Full sweep of all remaining `plebbit` and `subplebbit` keywords in `src/` and `test/` that were missed in earlier phases.

### 18.1 Wire Format: `subplebbitEdit` → `communityEdit`
- [x] `DecryptedChallengeRequestPublicationSchema` field: `subplebbitEdit` → `communityEdit` (src/pubsub-messages/schema.ts)
- [x] `DecryptedChallengeRequestMessageTypeWithCommunityAuthor` interface: `subplebbitEdit` → `communityEdit` (src/pubsub-messages/types.ts)
- [x] `CommunityEdit.getType()` return value: `"subplebbitEdit"` → `"communityEdit"` (src/publications/community-edit/community-edit.ts)
- [x] RPC method mapping key: `subplebbitEdit` → `communityEdit` (src/publications/publication.ts)
- [x] All `request.subplebbitEdit` → `request.communityEdit` in local-community.ts, rate-limiter.ts, utils.ts
- [x] All test files updated: type unions, variable names, property accesses

### 18.2 Comments & String Literals in src/
- [x] `plebbit is 0` → `pkc is 0` in upvote comments (src/pages/util.ts)
- [x] `subplebbit author` → `community author` in schema comments (src/pubsub-messages/schema.ts)
- [x] `plebbit-js` → `pkc-js` in code comments (src/schema.ts, src/rpc/src/index.ts, src/rpc/src/lib/pkc-js/index.ts)
- [x] `plebbit.destroy()` → `pkc.destroy()` in error message (src/runtime/node/test/helpers/hanging-runner.ts)

### 18.3 Dead/Commented-Out Code
- [x] Updated all `subplebbit`/`plebbit` references in commented-out mock code (src/rpc/src/lib/pkc-js/pkc-js-mock.ts)
- [x] `import Plebbit` → `import PKC`, `const plebbit` → `const pkc` (src/rpc/start.js)
- [x] `.plebbit` → `.pkc` in src/rpc/.gitignore

### 18.4 Test Configuration
- [x] `PLEBBIT_CONFIGS` → `PKC_CONFIGS` env var (test/run-test-config.js, src/test/test-util.ts, src/runtime/node/test/helpers/hanging-runner.ts, src/runtime/node/test/helpers/run-hanging-node.ts)
- [x] `--plebbit-config` → `--pkc-config` CLI flag (test/run-test-config.js, AGENTS.md)
- [x] Data dirs: `.plebbit*` → `.pkc*` (test/server/test-server.js, test/server/pkc-ws-server.js)

### 18.5 Test Server Infrastructure
- [x] Import renames: `startSubplebbits` → `startCommunities`, `mockPlebbitNoDataPathWithOnlyKuboClient` → `mockPKCNoDataPathWithOnlyKuboClient`, `mockRpcServerPlebbit` → `mockRpcServerPKC` (test/server/test-server.js, test/server/pkc-ws-server.js)
- [x] Variable renames: `plebbit` → `pkc`, `fetchLatestSubplebbit` → `fetchLatestCommunity`, `subplebbitRecord*` → `communityRecord*`, `plebbitWebSocketServer` → `pkcWebSocketServer`, etc.
- [x] `sub.raw.subplebbitIpfs` → `sub.raw.communityIpfs` (property was already renamed in src/)
- [x] `plebbit.getSubplebbit()` → `pkc.getCommunity()` (test/server/test-server.js)
- [x] `startPlebbitWebSocketServers` → `startPKCWebSocketServers` (test/server/pkc-ws-server.js)

### 18.6 Test File Descriptions & Variables
- [x] `plebbit-js` → `pkc-js` in test descriptions (signatures/pages.test.ts, signatures/comment.test.ts)
- [x] `subplebbitToSign` → `communityToSign` (signatures/community.test.ts)
- [x] `\.plebbit` → `\.pkc` regex (test.configs.pkc.test.ts)
- [x] `subplebbit owner` → `community owner` in challenge fixture comments (erc20-payment/index.js)

### 18.7 Items Intentionally Kept
- `subplebbitAddress` backward-compat code (publication-community.ts, db-handler.ts, pkc.ts, errors.ts)
- `plebbit.eth` / `plebbit.bso` test domain names
- External repo URLs not yet moved (`plebbit/plebbit-protocol-test`, `plebbit/plebbit-react-hooks`)
- `PLEBBIT_JS_BENCHMARKS_DEPLOY_KEY` GitHub secret name (not yet renamed)
- ~~Logger mapping tuples in `src/logger.ts`~~ (removed in `309d8fe65` — all call sites updated directly)
- JSON fixture file contents (wire-format backward-compat data)
- Comments documenting backward-compat behavior with old field names
- Old DNS record names in `docs/ens.md` migration section (`subplebbit-address`, `plebbit-author-address`)

---

## Notes

- Always run `npm run build` after each major phase to catch errors early
- Keep the old dist/ directory until all changes are complete
- Consider creating git branches for each major phase
- Some changes (DNS records, data paths) are breaking changes - document migration clearly
- External dependencies (@plebbit/plebbit-logger, etc.) require separate repository work

---

## Open Questions / Decisions Needed

### Q1: How to handle `subplebbitAddress` in publications?

**Superseded by [NAMES_AND_PUBLIC_KEY_PROPOSAL.md](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md).** Publications will use `communityPublicKey` (wire field, always present) and `communityName` (wire field, optional domain name) instead of `subplebbitAddress`. `communityAddress` is instance-only, computed as `communityName || communityPublicKey`. Old records with `subplebbitAddress` in `signedPropertyNames` remain valid via self-describing signature verification.

---

### Q2: DNS TXT record format (**RESOLVED**)

**Decision:** Use a single `bitsocial` TXT record key. The value is the IPNS public key (e.g., `12D3KooW...`).

This replaces the previous two-key approach (`subplebbit-address` and `plebbit-author-address`). A single lookup retrieves the community's or author's IPNS key — communities and author profiles are the same IPNS record (see [NAMES_AND_PUBLIC_KEY_PROPOSAL.md — Community/Author interoperability](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md#communityauthor-interoperability)), so one TXT value serves both.

**Format:**
- TXT record key: `bitsocial`
- Value: `<ipnsB58>` (e.g., `12D3KooWNvSZn...`)

No `author=12D...` prefix or key-value extensibility is needed — since communities and author profiles share the same IPNS record, a single IPNS key is sufficient. Telling users to set up `author=12D...` instead of just `12D...` would be unnecessarily complex with no protocol benefit.

**Benefits:**
- One TXT lookup instead of two (replaces `subplebbit-address` + `plebbit-author-address`)
- Simpler client flow
- Simpler setup for users — just set the IPNS key, no prefixes

---

### Q3: Should `resolveAuthorAddresses` be renamed to `resolveAuthorNames`? (**RESOLVED**)

**Decision: Yes.** The RPC method has already been renamed from `resolveAuthorAddress` → `resolveAuthorName` in both the RPC server (`src/rpc/src/index.ts:201`) and client (`src/clients/rpc-client/plebbit-rpc-client.ts:434`). The `resolveAuthorAddresses` option in `PlebbitUserOptionBaseSchema` should similarly be renamed to `resolveAuthorNames` during the Phase 7/8 rename.

---

### Q4: Should the `resolveAuthorAddress` RPC method be renamed? (**RESOLVED**)

**Decision: Already done.** The RPC method was renamed to `resolveAuthorName` in both the server and client. See Phase 9.1 where this is now marked as `[x]`.

---

## Progress Tracking

**How to mark progress:** When an item is completed, change `[ ]` to `[x]`. Example:
- `[ ] Not completed` → `[x] Completed`

Use this section to track overall progress:

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Web3 Modularization | [x] Done | All in-repo items complete. Name resolver done; challenge cleanup done; `resolveAuthorName` renamed; exported challenge types done; runtime author computation and `author.nameResolved` follow-up done; `nameResolved` reserved field fully implemented across all types; non-blocking author resolution; author.name validation moved to community; logger normalization complete; RPC challenge verification wrapper refactored. Deprecated `subplebbitAddress`/`communityAddress` wire fields rejected with distinct errors (`421efd796`). npm publishing deferred. Downstream apps (plebbit-cli, desktop) are separate repos |
| Phase 1B Step 1: SubplebbitIpfs wire format | [x] Done | `name` field added, `address`/`publicKey`/`nameResolved` instance-only, domain verification via key migration, `community.edit({name})` works, publicKey fallback loading, RPC support for all scenarios |
| Phase 1B Step 2: Publication wire format | [x] Done | `communityPublicKey`/`communityName` wire fields, `communityAddress` instance-only, backward compat via `preprocessCommentIpfsBackwardCompat()`, LocalCommunity normalizes old→new format. Backward compat fixes for `communityAddress` in page parsing and `raw.subplebbitIpfs` fallback (`d6abb4417`) |
| Phase 1B Step 3: DB migration | [x] Done | DB_VERSION=37, columns added, `subplebbitAddress` removed (in `extraProps` for CID reconstruction), v36→v37 and v29→v37 migration tests with production data patterns |
| Phase 2: Package Config | [x] Done | Package renamed to `@pkc/pkc-js`, README rewritten, AGENTS.md updated (`61b66f198`) |
| Phase 3: Directory Structure | [x] Done | All src/ and test/ directories renamed |
| Phase 4: Source Files | [x] Done | All files renamed within moved directories |
| Phase 5: Import Paths | [x] Done | All import paths updated in src/ and test/ |
| Phase 6: Classes & Types | [x] Done | All classes, types, and interfaces renamed (sections 6.1–6.3) |
| Phase 7: Schemas | [x] Done | All Zod schemas renamed (sections 7.1–7.7) |
| Phase 8: API Methods | [x] Done | All API methods and properties renamed (sections 8.1–8.5) |
| Phase 9: RPC Methods | [x] Done | All RPC methods, events, and params renamed (sections 9.1–9.4) |
| Phase 10: Errors & Logging | [x] Done | All error codes renamed; Logger runtime replacement removed (`309d8fe65`); all Logger calls use correct `pkc-js:` namespaces directly; "sub"→"community" in Logger calls (`d11432c0a`) |
| Phase 11: Signer Functions | [x] Done | All signer function renames and parameter renames done (sections 11.1–11.2) |
| Phase 12: Test Files | [x] Done | All file renames, content updates, fixture updates, and configuration changes done (sections 12.1–12.4) |
| Phase 13: DNS & Protocol | [x] Done | DNS TXT lookups + cache logic removed from core; migration documented in `docs/ens.md` |
| Phase 14: Data Migration | [x] Done | 14.1 code done + migration guide in `docs/protocol/data-path-migration.md`; 14.2 documented in `docs/ens.md`; 14.3 done in Phase 1B Step 3; 14.4 out of scope for pkc-js |
| Phase 14.3: DB Schema Migration | [x] Done | Completed as Phase 1B Step 3; comprehensive v29→v37 migration tests added (`6f4b31847`) |
| Phase 14.4: External Apps | [~] Out of Scope | plebbit-cli, desktop apps — see `docs/protocol/data-path-migration.md` |
| Phase 15: Documentation | [x] Done | All docs/ files updated, RPC README updated, duplicate EXPORT_SUBPLEBBIT_SPEC.md deleted (`bdc8064dd`) |
| Phase 16: GitHub & CI/CD | [x] Done | CI workflow files renamed and updated, benchmarks repo URL updated (`bdc8064dd`) |
| Phase 17: Build & Verify | [x] Done | Build, tests, and typechecks pass |
| Phase 18: Keyword Cleanup | [x] Done | Full sweep of remaining plebbit/subplebbit in src/ and test/; wire format `subplebbitEdit` → `communityEdit`; env var, test infra, comments, dead code; `PLEBBIT_CONFIGS` → `PKC_CONFIGS` (`499d8b9a9`) |

---

## External Repositories Requiring Changes

These repositories are outside plebbit-js but will need coordinated updates:

| Repository | Changes Needed | Status |
|------------|---------------|--------|
| @plebbit/plebbit-logger | Renamed to @pkc/pkc-logger | [x] Done |
| @plebbit/proper-lockfile | Renamed to @pkc/proper-lock-file | [x] Done |
| plebbit-cli | Directory migration: `.plebbit/` → `.pkc/` and `subplebbits/` → `communities/`, API updates, install name resolvers | [ ] Not Started |
| Desktop apps | Directory migration: `.plebbit/` → `.pkc/` and `subplebbits/` → `communities/`, API updates, install name resolvers | [ ] Not Started |
| plebbit-js-benchmarks | Rename repo to pkc-js-benchmarks, update all plebbit/subplebbit references | [ ] Not Started |
| plebbit-protocol-test | Rename repo to pkc-protocol-test, update wire format test fixtures for new field names, add backward compat tests for old records | [ ] Not Started |
| plebbit-react-hooks | Update all API references (method names, type imports, event names). Depends on pkc-js rename completing first | [ ] Not Started |
| DNS TXT records | Migrate `subplebbit-address` and `plebbit-author-address` → single `bitsocial` record | [ ] Not Started |

---

## Additional TODOs

- [ ] Update inaccuracies in `README.md`
- [ ] Replace outdated schemas and types in `README.md` with the current ones
- [ ] Add missing schemas and publication coverage to `README.md`
- [ ] Update `README.md` references from `plebbit-js` to `pkc-js`
- [ ] Add libraries that use `pkc-js` to `README.md`

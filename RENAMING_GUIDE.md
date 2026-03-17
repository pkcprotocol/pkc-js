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
- [ ] Ensure `getSubplebbit` / `getCommunity` RPC method resolves names server-side
- [ ] RPC client should NOT attempt local resolution before calling RPC
- [ ] `subplebbitUpdateSubscribe` / `communityUpdateSubscribe` should accept domain names and resolve server-side
- [ ] Document that RPC servers need resolvers configured, not RPC clients

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
- [ ] After rebrand, start publishing `@pkc/pkc-js` to the npm registry
- [ ] Add GitHub CI job(s) to automate npm publishing for `@pkc/pkc-js`

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

## Phase 2: Package Configuration & Project Files

### 2.1 Package Identity
- [ ] **package.json** - Rename package
  - `"name": "@plebbit/plebbit-js"` → `"name": "@pkc/pkc-js"`
  - Update `"repository"` URL if moving to new GitHub org
  - Update `"bugs"` URL
  - Update `"homepage"` URL
  - Update keywords: `"plebbit"`, `"plebbit-js"` → `"pkc"`, `"pkc-js"`
  - Update description

- [ ] **rpc/package.json** - Rename RPC package
  - `"name": "@plebbit/plebbit-js-rpc"` → `"name": "@pkc/pkc-js-rpc"`
  - Update repository URLs

### 2.2 External Dependencies (Document for Later)
The following dependencies are in the @plebbit namespace and need separate repository work (rename AFTER pkc-js rename):
- [ ] `@plebbit/plebbit-logger` - Note: Requires separate repo rename
- [ ] `@plebbit/proper-lockfile` - Note: Requires separate repo rename

### 2.3 RPC Package Configuration
- [ ] **rpc/package.json** - Update keywords
  - `"keywords": ["plebbit", "subplebbit"]` → `"keywords": ["pkc", "community"]`

### 2.4 Root Files
- [ ] **README.md** - Complete rewrite
  - Replace all "plebbit" → "pkc" (case-sensitive variations)
  - Replace all "subplebbit" → "community"
  - Replace all "Subplebbit" → "Community"
  - Update GitHub URLs if moving repos

- [ ] **CLAUDE.md** / **AGENTS.md** - Update references

- [ ] **project.json** - Update project metadata

---

## Phase 3: Directory Structure Renaming

### 3.1 Source Directories
- [ ] `src/plebbit/` → `src/pkc/`
- [ ] `src/subplebbit/` → `src/community/`
- [ ] `src/publications/subplebbit-edit/` → `src/publications/community-edit/`
- [ ] `src/runtime/node/subplebbit/` → `src/runtime/node/community/`
- [ ] `src/runtime/browser/subplebbit/` → `src/runtime/browser/community/`
- [ ] `src/rpc/src/lib/plebbit-js/` → `src/rpc/src/lib/pkc-js/`
- [ ] `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/` → `src/runtime/node/community/challenges/pkc-js-challenges/`

### 3.2 Test Directories
- [ ] `test/node/subplebbit/` → `test/node/community/`
- [ ] `test/node/subplebbit/challenges/` → `test/node/community/challenges/`
- [ ] `test/node/subplebbit/pubsub-msgs/` → `test/node/community/pubsub-msgs/`
- [ ] `test/node/plebbit/` → `test/node/pkc/`
- [ ] `test/node-and-browser/subplebbit/` → `test/node-and-browser/community/`
- [ ] `test/node-and-browser/subplebbit/posts/` → `test/node-and-browser/community/posts/`
- [ ] `test/node-and-browser/subplebbit/modqueue/` → `test/node-and-browser/community/modqueue/`
- [ ] `test/node-and-browser/plebbit/` → `test/node-and-browser/pkc/`
- [ ] `test/node-and-browser/publications/subplebbit-edit/` → `test/node-and-browser/publications/community-edit/`
- [ ] `test/fixtures/signatures/subplebbit/` → `test/fixtures/signatures/community/`

### 3.3 Data Storage Directories (Breaking Change)
- [ ] Default data path changes: `subplebbits/` → `communities/`
- [ ] Note: Migration code for old paths should be implemented in user-facing clients (plebbit-cli, desktop apps), NOT in pkc-js itself

---

## Phase 4: Source File Renaming

### 4.1 Plebbit → PKC Files
- [ ] `src/plebbit/plebbit.ts` → `src/pkc/pkc.ts`
- [ ] `src/plebbit/plebbit-with-rpc-client.ts` → `src/pkc/pkc-with-rpc-client.ts`
- [ ] `src/plebbit/plebbit-client-manager.ts` → `src/pkc/pkc-client-manager.ts`
- [ ] `src/plebbit/plebbit-clients.ts` → `src/pkc/pkc-clients.ts`
- [ ] `src/clients/rpc-client/plebbit-rpc-client.ts` → `src/clients/rpc-client/pkc-rpc-client.ts`
- [ ] `src/clients/plebbit-typed-emitter.ts` → `src/clients/pkc-typed-emitter.ts`
- [ ] `src/plebbit-error.ts` → `src/pkc-error.ts`
- [ ] `src/helia/helia-for-plebbit.ts` → `src/helia/helia-for-pkc.ts`
- [ ] `src/rpc/src/lib/plebbit-js/index.ts` → `src/rpc/src/lib/pkc-js/index.ts` (rename internal symbols: `PlebbitJs` → `PKCJs`, `setPlebbitJs` → `setPKCJs`, `restorePlebbitJs` → `restorePKCJs`)
- [ ] `src/rpc/src/lib/plebbit-js/plebbit-js-mock.ts` → `src/rpc/src/lib/pkc-js/pkc-js-mock.ts`
- [ ] `src/version.ts` - Update USER_AGENT string:
  - `/plebbit-js:${version}/` → `/pkc-js:${version}/`
- [ ] `src/test/node/hanging-test/scenarios/subplebbit-start.scenario.ts` → `src/test/node/hanging-test/scenarios/community-start.scenario.ts`
- [ ] `src/test/node/hanging-test/scenarios/subplebbit-update.scenario.ts` → `src/test/node/hanging-test/scenarios/community-update.scenario.ts`
- [ ] `src/rpc/test/node-and-browser/edgecases.plebbit.rpc.test.ts` → `src/rpc/test/node-and-browser/edgecases.pkc.rpc.test.ts`
- [ ] `src/rpc/test/node-and-browser/concurrency.plebbit.rpc.test.ts` → `src/rpc/test/node-and-browser/concurrency.pkc.rpc.test.ts`

### 4.2 Subplebbit → Community Files
- [ ] `src/subplebbit/remote-subplebbit.ts` → `src/community/remote-community.ts`
- [ ] `src/subplebbit/rpc-remote-subplebbit.ts` → `src/community/rpc-remote-community.ts`
- [ ] `src/subplebbit/rpc-local-subplebbit.ts` → `src/community/rpc-local-community.ts`
- [ ] `src/subplebbit/subplebbit-clients.ts` → `src/community/community-clients.ts`
- [ ] `src/subplebbit/subplebbit-client-manager.ts` → `src/community/community-client-manager.ts`
- [ ] `src/publications/subplebbit-edit/subplebbit-edit.ts` → `src/publications/community-edit/community-edit.ts`
- [ ] `src/runtime/node/subplebbit/local-subplebbit.ts` → `src/runtime/node/community/local-community.ts`
- [ ] `src/runtime/node/subplebbit/db-handler.ts` → `src/runtime/node/community/db-handler.ts`
- [ ] `src/runtime/node/subplebbit/page-generator.ts` → `src/runtime/node/community/page-generator.ts`
- [ ] `src/runtime/node/subplebbit/db-handler-types.ts` → `src/runtime/node/community/db-handler-types.ts` (contains `SubplebbitIpfsType` imports)
- [ ] `src/runtime/node/subplebbit/db-row-parser.ts` → `src/runtime/node/community/db-row-parser.ts`
- [ ] `src/runtime/node/subplebbit/keyv-better-sqlite3.ts` → `src/runtime/node/community/keyv-better-sqlite3.ts` (imports `PlebbitError`)
- [ ] `src/runtime/browser/subplebbit/local-subplebbit.ts` → `src/runtime/browser/community/local-community.ts`

### 4.3 Challenge System Files
- [ ] `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/index.ts` - Export rename:
  - `plebbitJsChallenges` → `pkcJsChallenges`
- [ ] `src/runtime/browser/subplebbit/challenges/` → `src/runtime/browser/community/challenges/`

### 4.4 Test File Renaming

**Note:** All test files should use the `.test.ts` TypeScript extension.

All test files in test/node/subplebbit/ and test/node-and-browser/subplebbit/:
- [ ] `*.subplebbit.test.ts` → `*.community.test.ts`

**test/node/plebbit/** (directory to be renamed to test/node/pkc/):
- [ ] `plebbit.test.ts` → `pkc.test.ts`
- [ ] `validatecomment.plebbit.test.ts` → `validatecomment.pkc.test.ts`
- [ ] `started-subplebbits.test.ts` → `started-communities.test.ts`

**test/node-and-browser/plebbit/** (directory to be renamed to test/node-and-browser/pkc/):
- [ ] `_updatingSubplebbits.plebbit.test.ts` → `_updatingCommunities.pkc.test.ts`

---

## Phase 5: Import Path Updates

After renaming directories and files, update ALL import statements across the codebase:

### 5.1 Core Imports
- [ ] `from "./plebbit/plebbit.js"` → `from "./pkc/pkc.js"`
- [ ] `from "./plebbit/plebbit-with-rpc-client.js"` → `from "./pkc/pkc-with-rpc-client.js"`
- [ ] `from "./plebbit/plebbit-client-manager.js"` → `from "./pkc/pkc-client-manager.js"`
- [ ] `from "./subplebbit/..."` → `from "./community/..."`
- [ ] `from "../plebbit-error.js"` → `from "../pkc-error.js"`

### 5.2 Publication Imports
- [ ] `from "./publications/subplebbit-edit/..."` → `from "./publications/community-edit/..."`

### 5.3 Runtime Imports
- [ ] `from "./runtime/node/subplebbit/..."` → `from "./runtime/node/community/..."`
- [ ] `from "./runtime/browser/subplebbit/..."` → `from "./runtime/browser/community/..."`

---

## Phase 6: Class, Type & Interface Renaming

### 6.1 Main Classes (src/plebbit/ → src/pkc/)
- [ ] Factory function `Plebbit()` → `PKC()` (src/index.ts — async factory function, the default export)
- [ ] `Plebbit.challenges` → `PKC.challenges` (static property on factory function)
- [ ] `Plebbit.setNativeFunctions` → `PKC.setNativeFunctions`
- [ ] `Plebbit.nativeFunctions` → `PKC.nativeFunctions`
- [ ] `Plebbit.getShortCid` → `PKC.getShortCid`
- [ ] `Plebbit.getShortAddress` → `PKC.getShortAddress`
- [ ] `class Plebbit` → `class PKC`
- [ ] `class PlebbitWithRpcClient` → `class PKCWithRpcClient`
- [ ] `class PlebbitRpcClient` → `class PKCRpcClient`
- [ ] `class PlebbitTypedEmitter` → `class PKCTypedEmitter`
- [ ] `class PlebbitClientsManager` → `class PKCClientsManager`
- [ ] `class PlebbitError` → `class PKCError`
- [ ] `class PlebbitIpfsGatewayClient` → `class PKCIpfsGatewayClient`
- [ ] `class PlebbitKuboRpcClient` → `class PKCKuboRpcClient`
- [ ] `class PlebbitLibp2pJsClient` → `class PKCLibp2pJsClient`
- [ ] `class PublicationPlebbitRpcStateClient` → `class PublicationPKCRpcStateClient` (src/publications/publication-clients.ts)
- [ ] `class CommentPlebbitRpcStateClient` → `class CommentPKCRpcStateClient` (src/publications/comment/comment-clients.ts)
- [ ] `class PublicationClientsManager` → rename only if base class `PlebbitClientsManager` rename propagates (src/publications/publication-client-manager.ts)
- [ ] `class PlebbitWsServer` → `class PKCWsServer` (src/rpc/src/index.ts — non-exported, but internal RPC server class)

### 6.2 Subplebbit Classes (src/subplebbit/ → src/community/)
- [ ] `class RemoteSubplebbit` → `class RemoteCommunity`
- [ ] `class RpcRemoteSubplebbit` → `class RpcRemoteCommunity`
- [ ] `class RpcLocalSubplebbit` → `class RpcLocalCommunity`
- [ ] `class LocalSubplebbit` → `class LocalCommunity`
- [ ] `class SubplebbitClientsManager` → `class CommunityClientsManager`
- [ ] `class SubplebbitKuboPubsubClient` → `class CommunityKuboPubsubClient`
- [ ] `class SubplebbitKuboRpcClient` → `class CommunityKuboRpcClient`
- [ ] `class SubplebbitPlebbitRpcStateClient` → `class CommunityPKCRpcStateClient`
- [ ] `class SubplebbitLibp2pJsClient` → `class CommunityLibp2pJsClient`
- [ ] `class SubplebbitIpfsGatewayClient` → `class CommunityIpfsGatewayClient`
- [ ] `class SubplebbitEdit` → `class CommunityEdit`
- [ ] `class SubplebbitPostsPagesClientsManager` → `class CommunityPostsPagesClientsManager` (src/pages/pages-client-manager.ts)
- [ ] `class SubplebbitModQueueClientsManager` → `class CommunityModQueueClientsManager` (src/pages/pages-client-manager.ts)
- [ ] `class PagesPlebbitRpcStateClient` → `class PagesPKCRpcStateClient` (src/pages/pages-clients.ts)

### 6.3 Type Definitions (src/types.ts, src/subplebbit/types.ts)
**Plebbit types:**
- [ ] `interface PlebbitEvents` → `interface PKCEvents` (includes renaming event key `"subplebbitschange"` → `"communitieschange"` in the interface definition)
- [ ] `interface PlebbitRpcClientEvents` → `interface PKCRpcClientEvents`
- [ ] `interface ParsedPlebbitOptions` → `interface ParsedPKCOptions`
- [ ] `type InputPlebbitOptions` → `type InputPKCOptions`
- [ ] `type PlebbitMemCaches` → `type PKCMemCaches`
- [ ] `interface PlebbitIpnsGetOptions` → `interface PKCIpnsGetOptions`
- [ ] `interface PlebbitWsServerClassOptions` → `interface PKCWsServerClassOptions`
- [ ] `type PlebbitWsServerSettingsSerialized` → `type PKCWsServerSettingsSerialized`
- [ ] `type PlebbitRpcServerEvents` → `type PKCRpcServerEvents`
- [ ] `type PlebbitRecordToVerify` → `type PKCRecordToVerify`
- [ ] `type IpfsSubplebbitStats` → `type IpfsCommunityStats` (src/types.ts)
- [ ] `type PubsubSubplebbitStats` → `type PubsubCommunityStats` (src/types.ts)
- [ ] `type ResultOfFetchingSubplebbit` → `type ResultOfFetchingCommunity` (src/types.ts)

**Subplebbit types:**
- [ ] `type SubplebbitStats` → `type CommunityStats`
- [ ] `type SubplebbitFeatures` → `type CommunityFeatures`
- [ ] `type SubplebbitSuggested` → `type CommunitySuggested`
- [ ] `type SubplebbitEncryption` → `type CommunityEncryption`
- [ ] `type SubplebbitRole` → `type CommunityRole`
- [ ] `type SubplebbitRoleNameUnion` → `type CommunityRoleNameUnion`
- [ ] `type SubplebbitIpfsType` → `type CommunityIpfsType`
- [ ] `interface SubplebbitSignature` → `interface CommunitySignature`
- [ ] `type SubplebbitChallenge` → `type CommunityChallenge`
- [ ] `type SubplebbitChallengeSetting` → `type CommunityChallengeSetting`
- [ ] `type SubplebbitSettings` → `type CommunitySettings`
- [ ] `type SubplebbitState` → `type CommunityState`
- [ ] `type SubplebbitStartedState` → `type CommunityStartedState`
- [ ] `type SubplebbitUpdatingState` → `type CommunityUpdatingState`
- [ ] `type SubplebbitJson` → `type CommunityJson`
- [ ] `interface SubplebbitEvents` → `interface CommunityEvents`
- [ ] `type RemoteSubplebbitJson` → `type RemoteCommunityJson`
- [ ] `type RpcRemoteSubplebbitJson` → `type RpcRemoteCommunityJson`
- [ ] `type RpcLocalSubplebbitJson` → `type RpcLocalCommunityJson`
- [ ] `type LocalSubplebbitJson` → `type LocalCommunityJson`
- [ ] `type CreateRemoteSubplebbitOptions` → `type CreateRemoteCommunityOptions`
- [ ] `type CreateNewLocalSubplebbitUserOptions` → `type CreateNewLocalCommunityUserOptions`
- [ ] `type CreateNewLocalSubplebbitParsedOptions` → `type CreateNewLocalCommunityParsedOptions`
- [ ] `type SubplebbitEditOptions` → `type CommunityEditOptions`
- [ ] `type ParsedSubplebbitEditOptions` → `type ParsedCommunityEditOptions`
- [ ] All `*WithSubplebbitAuthor` types → `*WithCommunityAuthor`
- [ ] `type InternalSubplebbitRecordBeforeFirstUpdateType` → `type InternalCommunityRecordBeforeFirstUpdateType` (src/subplebbit/types.ts)
- [ ] `type InternalSubplebbitRecordAfterFirstUpdateType` → `type InternalCommunityRecordAfterFirstUpdateType` (src/subplebbit/types.ts)
- [ ] `type RpcInternalSubplebbitRecordBeforeFirstUpdateType` → `type RpcInternalCommunityRecordBeforeFirstUpdateType` (src/subplebbit/types.ts)
- [ ] `type RpcInternalSubplebbitRecordAfterFirstUpdateType` → `type RpcInternalCommunityRecordAfterFirstUpdateType` (src/subplebbit/types.ts)
- [ ] `type RpcLocalSubplebbitUpdateResultType` → `type RpcLocalCommunityUpdateResultType` (src/subplebbit/types.ts)
- [ ] `type SubplebbitEventArgs` → `type CommunityEventArgs` (src/subplebbit/types.ts)
- [ ] `type SubplebbitRpcErrorToTransmit` → `type CommunityRpcErrorToTransmit` (src/subplebbit/types.ts)

**SubplebbitEdit types (src/publications/subplebbit-edit/types.ts):**
- [ ] `type CreateSubplebbitEditPublicationOptions` → `type CreateCommunityEditPublicationOptions`
- [ ] `type SubplebbitEditChallengeRequestToEncryptType` → `type CommunityEditChallengeRequestToEncryptType`
- [ ] `type SubplebbitEditJson` → `type CommunityEditJson`
- [ ] `interface SubplebbitEditPublicationOptionsToSign` → `interface CommunityEditPublicationOptionsToSign`
- [ ] `interface SubplebbitEditPublicationSignature` → `interface CommunityEditPublicationSignature`
- [ ] `type SubplebbitEditPubsubMessagePublication` → `type CommunityEditPubsubMessagePublication`
- [ ] `interface SubplebbitEditPublicationPubsubMessageWithSubplebbitAuthor` → `interface CommunityEditPublicationPubsubMessageWithCommunityAuthor`

**SubplebbitEdit schemas (src/publications/subplebbit-edit/schema.ts):**
- [ ] `CreateSubplebbitEditPublicationOptionsSchema` → `CreateCommunityEditPublicationOptionsSchema`
- [ ] `SubplebbitEditPubsubMessagePublicationSchema` → `CommunityEditPubsubMessagePublicationSchema`
- [ ] `SubplebbitEditPublicationChallengeRequestToEncryptSchema` → `CommunityEditPublicationChallengeRequestToEncryptSchema`
- [ ] `SubplebbitEditPublicationPubsubReservedFields` → `CommunityEditPublicationPubsubReservedFields`

**Subplebbit schema constants (src/subplebbit/schema.ts):**
- [ ] `SubplebbitIpfsReservedFields` → `CommunityIpfsReservedFields`

**RPC types (src/rpc/src/types.ts):**
- [ ] `interface RpcSubplebbitState` → `interface RpcCommunityState`

---

## Phase 7: Schema Renaming (Zod)

### 7.1 Main Schemas (src/schema.ts)
- [ ] `PlebbitUserOptionBaseSchema` → `PKCUserOptionBaseSchema`
- [ ] `PlebbitUserOptionsSchema` → `PKCUserOptionsSchema`
- [ ] `PlebbitParsedOptionsSchema` → `PKCParsedOptionsSchema`
- [ ] Property: `plebbitRpcClientsOptions` → `pkcRpcClientsOptions`

### 7.2 Author & Shared Schemas (src/schema/schema.ts)
- [ ] `SubplebbitAddressSchema` → `CommunityAddressSchema`
- [ ] `PlebbitTimestampSchema` → `PKCTimestampSchema`
- [ ] `SubplebbitAuthorSchema` → `CommunityAuthorSchema`
- [ ] **Remove** `address` from `AuthorPubsubSchema` — now instance-only, computed as `name || publicKey` (**breaking change**)
- [ ] **Remove** `address` from `AuthorIpfsSchema` — now instance-only (**breaking change**)
- [ ] **Add** `name: z.string().min(1).optional()` to `AuthorPubsubSchema` and `AuthorIpfsSchema` (wire field — domain name like `"vitalik.bso"`)
- [ ] Use `.loose()` on author schemas to accept old records with `address` field (do NOT use `.strip()` — stripping can remove fields referenced in `signedPropertyNames` and corrupt signature verification)

### 7.3 Subplebbit Schemas (src/subplebbit/schema.ts)
- [ ] `SubplebbitEncryptionSchema` → `CommunityEncryptionSchema`
- [ ] `SubplebbitRoleSchema` → `CommunityRoleSchema`
- [ ] `SubplebbitRoleNames` → `CommunityRoleNames`
- [ ] `SubplebbitSuggestedSchema` → `CommunitySuggestedSchema`
- [ ] `SubplebbitFeaturesSchema` → `CommunityFeaturesSchema`
- [ ] `SubplebbitChallengeSettingSchema` → `CommunityChallengeSettingSchema`
- [ ] `SubplebbitChallengeSchema` → `CommunityChallengeSchema`
- [ ] `SubplebbitIpfsSchema` → `CommunityIpfsSchema`
- [ ] `SubplebbitSignedPropertyNames` → `CommunitySignedPropertyNames`
- [ ] `SubplebbitSignatureSchema` → `CommunitySignatureSchema`
- [ ] `CreateRemoteSubplebbitOptionsSchema` → `CreateRemoteCommunityOptionsSchema`
- [ ] `SubplebbitSettingsSchema` → `CommunitySettingsSchema`
- [ ] `SubplebbitEditOptionsSchema` → `CommunityEditOptionsSchema`
- [ ] `SubplebbitEditPublicationChallengeRequestToEncryptSchema` → `CommunityEditPublicationChallengeRequestToEncryptSchema`
- [ ] `CreateRemoteSubplebbitFunctionArgumentSchema` → `CreateRemoteCommunityFunctionArgumentSchema`
- [ ] `CreateNewLocalSubplebbitUserOptionsSchema` → `CreateNewLocalCommunityUserOptionsSchema`
- [ ] `CreateNewLocalSubplebbitParsedOptionsSchema` → `CreateNewLocalCommunityParsedOptionsSchema`
- [ ] `ChallengeExcludeSubplebbitSchema` → `ChallengeExcludeCommunitySchema`
- [ ] `ChallengeExcludeSchema` field: `subplebbit` → `community` (the field name referencing `ChallengeExcludeCommunitySchema`)
- [ ] `ChallengeExcludePublicationTypeSchema` field: `subplebbitEdit` → `communityEdit`
- [ ] `RpcRemoteSubplebbitUpdateEventResultSchema` → `RpcRemoteCommunityUpdateEventResultSchema`
- [ ] **Remove** `address` from `SubplebbitIpfsSchema` — instance-only, computed as `name || publicKey` (see [proposal](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md#1-add-name-field-to-subplebbitipfs))
- [ ] Use `.loose()` on `SubplebbitIpfsSchema` to accept old records that include `address` field (do NOT use `.strip()` — stripping can remove fields referenced in `signedPropertyNames` and corrupt signature verification)
- [ ] `CreateRpcSubplebbitFunctionArgumentSchema` → `CreateRpcCommunityFunctionArgumentSchema` (src/subplebbit/schema.ts)
- [ ] `ListOfSubplebbitsSchema` → `ListOfCommunitiesSchema` (src/subplebbit/schema.ts)

### 7.4 RPC Client Schemas (src/clients/rpc-client/schema.ts)
- [ ] `RpcSubplebbitAddressParamSchema` → `RpcCommunityAddressParamSchema`
- [ ] `RpcSubplebbitPageParamSchema` → `RpcCommunityPageParamSchema`

### 7.4.1 RPC Server Schemas (src/rpc/src/schema.ts)
- [ ] `CreatePlebbitWsServerOptionsSchema` → `CreatePKCWsServerOptionsSchema`
- [ ] `SetNewSettingsPlebbitWsServerSchema` → `SetNewSettingsPKCWsServerSchema`
- [ ] `PlebbitWsServerSettingsSerializedSchema` → `PKCWsServerSettingsSerializedSchema`

### 7.4.2 RPC Server Types (src/rpc/src/types.ts)
- [ ] `type CreatePlebbitWsServerOptions` → `type CreatePKCWsServerOptions`
- [ ] `type SetNewSettingsPlebbitWsServer` → `type SetNewSettingsPKCWsServer`

### 7.4.3 SubplebbitEdit Schemas (src/publications/subplebbit-edit/schema.ts)
- [ ] `SubplebbitEditPublicationSignedPropertyNames` → `CommunityEditPublicationSignedPropertyNames`

### 7.4.4 Publication Comment Types (src/publications/comment/types.ts)
- [ ] `type SubplebbitAuthor` → `type CommunityAuthor`

### 7.5 Signed Property Names

Update the `signedPropertyNames` arrays to reflect wire format changes:
- [ ] `SubplebbitSignedPropertyNames`: add `name`, remove `address`
- [ ] Publication signed property names: add `communityPublicKey` and `communityName`, remove `subplebbitAddress`
- [ ] Author signed property names: add `name`, remove `address`

**Note:** Old records with old `signedPropertyNames` remain valid — self-describing signature verification reads `signedPropertyNames` from each record. No explicit protocol version field is needed for backward compatibility.

### 7.6 Schema Parser Functions (src/schema/schema-util.ts)
- [ ] All `parse*PlebbitErrorIfItFails` → `parse*PKCErrorIfItFails`
- [ ] All `parse*SubplebbitSchemaWithPlebbitErrorIfItFails` → `parse*CommunitySchemaWithPKCErrorIfItFails`

### 7.7 Backward Compatibility Tests for Old Records

Add tests to verify old records with legacy field names are parsed correctly:
- [ ] Test parsing old `SubplebbitIpfs` records that include `address` field (should be accepted via `.loose()`)
- [ ] Test parsing old `CommentIpfs` records that include `subplebbitAddress` field (should be accepted via `.loose()`)
- [ ] Test parsing old `AuthorPubsub` records that include `address` field (should be accepted via `.loose()`)
- [ ] Test signature verification of old records with old `signedPropertyNames` (self-describing verification should still pass)

**Important:** Use `.loose()` not `.strip()` when parsing old records — `.strip()` can remove fields referenced in `signedPropertyNames` and corrupt signature verification.

---

## Phase 8: API Method & Property Renaming

### 8.1 Plebbit/PKC Class Methods
- [ ] `plebbit.createSubplebbit()` → `pkc.createCommunity()`
- [ ] `plebbit.getSubplebbit()` → `pkc.getCommunity()`
- [ ] `plebbit.listSubplebbits()` → `pkc.listCommunities()`

### 8.1.1 PlebbitWithRpcClient Internal Methods
- [ ] `_initPlebbitRpcClients()` → `_initPKCRpcClients()`

### 8.2 Plebbit/PKC Class Properties
- [ ] `plebbit.subplebbits` → `pkc.communities`
- [ ] `plebbit._updatingSubplebbits` → `pkc._updatingCommunities`
- [ ] `plebbit._startedSubplebbits` → `pkc._startedCommunities`
  - **Note:** Index these maps by `publicKey` (not `address`) to prevent duplicate entries when the same community is accessed by name and publicKey (see [proposal](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md#2-add-communitypublickey-and-communityname-to-publications))
- [ ] `plebbit._subplebbitFsWatchAbort` → `pkc._communityFsWatchAbort`
- [ ] `plebbit.plebbitRpcClientsOptions` → `pkc.pkcRpcClientsOptions`
- [ ] `plebbit._plebbitRpcClient` → `pkc._pkcRpcClient`
- [ ] `plebbit._userPlebbitOptions` → `pkc._userPKCOptions`
- [ ] `plebbit._memCaches` (type change to PKCMemCaches)
- [ ] `plebbit.clients.plebbitRpcClients` → `pkc.clients.pkcRpcClients`

### 8.2.0 Plebbit/PKC Class Event Names
Class-level events (not RPC — those are in Phase 9.2):
- [ ] `"subplebbitschange"` → `"communitieschange"` (emitted by `Plebbit`/`PKC` class in `src/plebbit/plebbit.ts`)

### 8.2.1 PlebbitRpcClient Internal Properties
- [ ] `PlebbitRpcClient.subplebbits` → `PKCRpcClient.communities` (array tracking subplebbit addresses received via RPC)

### 8.2.2 Utility Functions (src/runtime/node/util.ts)
- [ ] `getDefaultSubplebbitDbConfig()` → `getDefaultCommunityDbConfig()`
- [ ] `deleteOldSubplebbitInWindows()` → `deleteOldCommunityInWindows()`

### 8.2.3 RPC Schema Utility Functions (src/clients/rpc-client/rpc-schema-util.ts)
- [ ] `parseRpcSubplebbitAddressParam()` → `parseRpcCommunityAddressParam()`
- [ ] `parseRpcSubplebbitPageParam()` → `parseRpcCommunityPageParam()`

### 8.2.4 RPC Client Types (src/clients/rpc-client/types.ts)
- [ ] `SubplebbitAddressRpcParam` → `CommunityAddressRpcParam`
- [ ] `SubplebbitPageRpcParam` → `CommunityPageRpcParam`

### 8.3 Publication Properties (Breaking Change)
**See [NAMES_AND_PUBLIC_KEY_PROPOSAL.md](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md) for wire format decisions.**
- [ ] `publication.subplebbitAddress` → replace with wire fields `communityPublicKey` (optional, for backward compat) + `communityName` (optional); `communityAddress` is instance-only (computed as `communityName || communityPublicKey`)
- [ ] `publication.shortSubplebbitAddress` → `publication.shortCommunityAddress`
  - **Note:** This is a different property from `community.shortAddress` (on RemoteSubplebbit/RemoteCommunity, derived from `community.address`). `community.shortAddress` stays as `shortAddress` — no rename needed. Only the publication-level `shortSubplebbitAddress` is renamed.

**Backward compatibility for old publications:**
- `communityPublicKey` is **optional** in the wire schema. Required for new publications, absent on old ones.
- When parsing old `CommentIpfs` records that have `subplebbitAddress` but no `communityPublicKey`:
  - If `subplebbitAddress` is an IPNS key → use it as `communityPublicKey`
  - If `subplebbitAddress` is a domain → fill `communityPublicKey` from community context (the community serving the page/update knows its own publicKey)
- Old comments remain loadable.

### 8.3.1 Author Properties (Breaking Change)
- [ ] `author.subplebbit` → `author.community` (property on AuthorIpfsSchema containing community-specific author data)
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

### 8.4 Timeout Keys (src/plebbit/plebbit.ts)
- [ ] `"subplebbit-ipns"` → `"community-ipns"`
- [ ] `"subplebbit-ipfs"` → `"community-ipfs"`

### 8.5 State Machine States (Public API - affects downstream consumers)
State strings emitted via `statechange` and `publishingstatechange` events:
- [ ] `"resolving-subplebbit-address"` → `"resolving-community-address"` (src/publications/types.ts, src/publications/comment/types.ts)
- [ ] `"fetching-subplebbit-ipns"` → `"fetching-community-ipns"`
- [ ] `"fetching-subplebbit-ipfs"` → `"fetching-community-ipfs"`
- [ ] Chain provider state: `"resolving-subplebbit-address"` → `"resolving-community-address"` (src/clients/chain-provider-client.ts)

**Note:** The codebase has a two-level state system. The **internal** `SubplebbitUpdatingState` (in `src/subplebbit/types.ts`) uses `"resolving-address"` (no entity prefix) and stays unchanged. The **external** client-facing states listed above (mapped in `rpc-remote-subplebbit.ts` and `publication-client-manager.ts`) are the ones that get renamed. Do not rename the internal `"resolving-address"` state.

---

## Phase 9: RPC Method Renaming

### 9.1 RPC Server Methods (src/rpc/src/index.ts)
- [ ] `getSubplebbitPage` → `getCommunityPage`
- [ ] `createSubplebbit` → `createCommunity`
- [ ] `startSubplebbit` → `startCommunity`
- [ ] `stopSubplebbit` → `stopCommunity`
- [ ] `editSubplebbit` → `editCommunity`
- [ ] `deleteSubplebbit` → `deleteCommunity`
- [ ] `subplebbitsSubscribe` → `communitiesSubscribe`
- [ ] `subplebbitUpdateSubscribe` → `communityUpdateSubscribe`
- [ ] `publishSubplebbitEdit` → `publishCommunityEdit`
- [x] `resolveAuthorAddress` → `resolveAuthorName` (already renamed in both RPC server `src/rpc/src/index.ts:201` and client `src/clients/rpc-client/plebbit-rpc-client.ts:434`)

### 9.2 RPC Event Names
- [ ] `"subplebbitschange"` → `"communitieschange"`
- [ ] `"subplebbitUpdateNotification"` → `"communityUpdateNotification"`
- [ ] `"subplebbitsNotification"` → `"communitiesNotification"`
- [ ] `"publishSubplebbitEditNotification"` → `"publishCommunityEditNotification"`

### 9.3 RPC Parameter Names (Wire Protocol)
- [ ] `RpcSubplebbitPageParamSchema.subplebbitAddress` → `communityAddress` (src/clients/rpc-client/schema.ts)
- [ ] `getSubplebbitPage` params: `{ subplebbitAddress }` → `{ communityAddress }` (src/rpc/src/index.ts)
- [ ] `getCommentPage` params: `{ subplebbitAddress }` → `{ communityAddress }` (src/rpc/src/index.ts)

### 9.4 RPC Name Resolution (Server-Side)
- [ ] `getCommunity` / `communityUpdateSubscribe` RPC methods must accept domain names — name resolution happens server-side using the RPC server's registered `nameResolvers`
- [ ] Add error response when server-side name resolution fails (`ERR_NAME_RESOLUTION_FAILED`)
- [ ] RPC clients don't need `nameResolvers` config — they delegate resolution to the server

---

## Phase 10: Error Messages & Logging

### 10.1 Error Classes (src/plebbit-error.ts → src/pkc-error.ts)
- [ ] `PlebbitError` → `PKCError`
- [ ] `FailedToFetchSubplebbitFromGatewaysError` → `FailedToFetchCommunityFromGatewaysError`
- [ ] `FailedToFetchCommentIpfsFromGatewaysError` (keep as is - comment not subplebbit)
- [ ] `FailedToFetchCommentUpdateFromGatewaysError` (keep as is)
- [ ] `FailedToFetchPageIpfsFromGatewaysError` (keep as is)
- [ ] `FailedToFetchGenericIpfsFromGatewaysError` (keep as is)

### 10.2 Error Codes (src/errors.ts)

**SUBPLEBBIT → COMMUNITY error codes:**
- [ ] `ERR_SUB_SIGNER_NOT_DEFINED` → `ERR_COMMUNITY_SIGNER_NOT_DEFINED`
- [ ] `ERR_SUB_CAN_EITHER_RUN_OR_UPDATE` → `ERR_COMMUNITY_CAN_EITHER_RUN_OR_UPDATE`
- [ ] `ERR_SUBPLEBBIT_MISSING_FIELD` → `ERR_COMMUNITY_MISSING_FIELD`
- [ ] `ERR_SUBPLEBBIT_OPTIONS_MISSING_ADDRESS` → `ERR_COMMUNITY_OPTIONS_MISSING_ADDRESS`
- [ ] `ERR_INVALID_SUBPLEBBIT_ADDRESS_SCHEMA` → `ERR_INVALID_COMMUNITY_ADDRESS_SCHEMA`
- [ ] `ERR_SUB_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS` → `ERR_COMMUNITY_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS`
- [ ] `ERR_COMMENT_IPFS_SUBPLEBBIT_ADDRESS_MISMATCH` → `ERR_COMMENT_IPFS_COMMUNITY_ADDRESS_MISMATCH`
- [ ] `ERR_NEED_TO_STOP_UPDATING_SUB_BEFORE_STARTING` → `ERR_NEED_TO_STOP_UPDATING_COMMUNITY_BEFORE_STARTING`
- [ ] `ERR_GET_SUBPLEBBIT_TIMED_OUT` → `ERR_GET_COMMUNITY_TIMED_OUT`
- [ ] `ERR_CALLED_SUBPLEBBIT_STOP_WITHOUT_UPDATE` → `ERR_CALLED_COMMUNITY_STOP_WITHOUT_UPDATE`
- [ ] `ERR_CAN_NOT_RUN_A_SUB_WITH_NO_IPFS_NODE` → `ERR_CAN_NOT_RUN_A_COMMUNITY_WITH_NO_IPFS_NODE`
- [ ] `ERR_CAN_NOT_CREATE_A_LOCAL_SUB` → `ERR_CAN_NOT_CREATE_A_LOCAL_COMMUNITY`
- [ ] `ERR_SUB_ADDRESS_IS_PROVIDED_AS_NULL_OR_UNDEFINED` → `ERR_COMMUNITY_ADDRESS_IS_PROVIDED_AS_NULL_OR_UNDEFINED`
- [ ] `ERR_UNABLE_TO_DERIVE_PUBSUB_SUBPLEBBIT_EDIT_PUBLICATION_FROM_JSONIFIED_SUBPLEBBIT_EDIT` → `ERR_UNABLE_TO_DERIVE_PUBSUB_COMMUNITY_EDIT_PUBLICATION_FROM_JSONIFIED_COMMUNITY_EDIT`
- [ ] `ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS` → `ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS`
- [ ] `ERR_SUBPLEBBIT_HAS_NO_POST_UPDATES` → `ERR_COMMUNITY_HAS_NO_POST_UPDATES`
- [ ] `ERR_GATEWAY_ABORTING_LOADING_SUB_BECAUSE_SAME_INVALID_SUBPLEBBIT_RECORD` → `ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_SAME_INVALID_COMMUNITY_RECORD`
- [ ] `ERR_GATEWAY_ABORTING_LOADING_SUB_BECAUSE_SAME_UPDATE_CID` → `ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_SAME_UPDATE_CID`
- [ ] `ERR_GATEWAY_ABORTING_LOADING_SUB_BECAUSE_WE_ALREADY_LOADED_THIS_RECORD` → `ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_WE_ALREADY_LOADED_THIS_RECORD`
- [ ] `ERR_REMOTE_SUBPLEBBIT_RECEIVED_ALREADY_PROCCESSED_RECORD` → `ERR_REMOTE_COMMUNITY_RECEIVED_ALREADY_PROCCESSED_RECORD`
- [ ] `ERR_INVALID_SUBPLEBBIT_IPFS_SCHEMA` → `ERR_INVALID_COMMUNITY_IPFS_SCHEMA`
- [ ] `ERR_INVALID_RPC_LOCAL_SUBPLEBBIT_UPDATE_SCHEMA` → `ERR_INVALID_RPC_LOCAL_COMMUNITY_UPDATE_SCHEMA`
- [ ] `ERR_INVALID_RPC_SUBPLEBBIT_UPDATING_STATE_SCHEMA` → `ERR_INVALID_RPC_COMMUNITY_UPDATING_STATE_SCHEMA`
- [ ] `ERR_INVALID_RPC_SUBPLEBBIT_STARTED_STATE_SCHEMA` → `ERR_INVALID_RPC_COMMUNITY_STARTED_STATE_SCHEMA`
- [ ] `ERR_INVALID_RPC_ENCODED_CHALLENGE_REQUEST_WITH_SUBPLEBBIT_AUTHOR_PUBSUB_MSG_SCHEMA` → `ERR_INVALID_RPC_ENCODED_CHALLENGE_REQUEST_WITH_COMMUNITY_AUTHOR_PUBSUB_MSG_SCHEMA`
- [ ] `ERR_INVALID_RPC_REMOTE_SUBPLEBBIT_SCHEMA` → `ERR_INVALID_RPC_REMOTE_COMMUNITY_SCHEMA`
- [ ] `ERR_LOCAL_SUBPLEBIT_PRODUCED_INVALID_SCHEMA` → `ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SCHEMA`
- [ ] `ERR_INVALID_CREATE_SUBPLEBBIT_ARGS_SCHEMA` → `ERR_INVALID_CREATE_COMMUNITY_ARGS_SCHEMA`
- [ ] `ERR_INVALID_CREATE_REMOTE_SUBPLEBBIT_ARGS_SCHEMA` → `ERR_INVALID_CREATE_REMOTE_COMMUNITY_ARGS_SCHEMA`
- [ ] `ERR_INVALID_CREATE_SUBPLEBBIT_EDIT_ARGS_SCHEMA` → `ERR_INVALID_CREATE_COMMUNITY_EDIT_ARGS_SCHEMA`
- [ ] `ERR_INVALID_CREATE_NEW_LOCAL_SUB_USER_OPTIONS` → `ERR_INVALID_CREATE_NEW_LOCAL_COMMUNITY_USER_OPTIONS`
- [ ] `ERR_INVALID_SUBPLEBBIT_EDIT_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA` → `ERR_INVALID_COMMUNITY_EDIT_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA`
- [ ] `ERR_SUBPLEBBIT_EDIT_OPTIONS_SCHEMA` → `ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA`
- [ ] `ERR_INVALID_CREATE_SUBPLEBBIT_WITH_RPC_ARGS_SCHEMA` → `ERR_INVALID_CREATE_COMMUNITY_WITH_RPC_ARGS_SCHEMA`
- [ ] `ERR_CAN_NOT_SET_EXCLUDE_PUBLICATION_TO_EMPTY_OBJECT` → (keep as is - no subplebbit in name)
- [ ] `ERR_SUB_HAS_NO_INTERNAL_STATE` → `ERR_COMMUNITY_HAS_NO_INTERNAL_STATE`
- [ ] `ERR_THE_SUBPLEBBIT_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED` → `ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED`
- [ ] `ERR_SUBPLEBBIT_IPNS_NAME_DOES_NOT_MATCH_SIGNATURE_PUBLIC_KEY` → `ERR_COMMUNITY_IPNS_NAME_DOES_NOT_MATCH_SIGNATURE_PUBLIC_KEY`
- [ ] `ERR_COMMENT_UPDATE_IS_NOT_SIGNED_BY_SUBPLEBBIT` → `ERR_COMMENT_UPDATE_IS_NOT_SIGNED_BY_COMMUNITY`
- [ ] `ERR_CHALLENGE_MSG_SIGNER_IS_NOT_SUBPLEBBIT` → `ERR_CHALLENGE_MSG_SIGNER_IS_NOT_COMMUNITY`
- [ ] `ERR_CHALLENGE_VERIFICATION_MSG_SIGNER_IS_NOT_SUBPLEBBIT` → `ERR_CHALLENGE_VERIFICATION_MSG_SIGNER_IS_NOT_COMMUNITY`
- [ ] `ERR_LOCAL_SUBPLEBBIT_PRODUCED_INVALID_SIGNATURE` → `ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SIGNATURE`
- [ ] `ERR_SUBPLEBBIT_POSTS_INVALID` → `ERR_COMMUNITY_POSTS_INVALID`
- [ ] `ERR_SUBPLEBBIT_EDIT_HAS_RESERVED_FIELD` → `ERR_COMMUNITY_EDIT_HAS_RESERVED_FIELD`
- [ ] `ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID` → `ERR_COMMUNITY_SIGNATURE_IS_INVALID`
- [ ] `ERR_SUBPLEBBIT_RECORD_INCLUDES_RESERVED_FIELD` → `ERR_COMMUNITY_RECORD_INCLUDES_RESERVED_FIELD`
- [ ] `ERR_FAILED_TO_RESOLVE_SUBPLEBBIT_DOMAIN` → `ERR_FAILED_TO_RESOLVE_COMMUNITY_DOMAIN`
- [ ] `ERR_DOMAIN_ADDRESS_HAS_CAPITAL_LETTER` → `ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER`
- [ ] `ERR_SUBPLEBBIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES` → `ERR_COMMUNITY_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES`
- [ ] `ERR_SUBPLEBBIT_EDIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES` → `ERR_COMMUNITY_EDIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES`
- [ ] `ERR_SUB_CHANGED_COMMENT_PUBSUB_PUBLICATION_PROPS` → `ERR_COMMUNITY_CHANGED_COMMENT_PUBSUB_PUBLICATION_PROPS`
- [ ] `ERR_SUB_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENT` → `ERR_COMMUNITY_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENT`
- [ ] `ERR_SUB_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENTUPDATE` → `ERR_COMMUNITY_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENTUPDATE`
- [ ] `ERR_SUB_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_CID` → `ERR_COMMUNITY_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_CID`
- [ ] `ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_SUB` → `ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY`
- [ ] `ERR_DOMAIN_SUB_ADDRESS_TXT_RECORD_POINT_TO_DIFFERENT_ADDRESS` → `ERR_DOMAIN_COMMUNITY_ADDRESS_TXT_RECORD_POINT_TO_DIFFERENT_ADDRESS`
- [ ] `ERR_SUBPLEBBIT_DOMAIN_HAS_NO_TEXT_RECORD` → `ERR_COMMUNITY_DOMAIN_HAS_NO_TEXT_RECORD`
- [ ] `ERR_LOCAL_SUB_HAS_NO_SIGNER_IN_INTERNAL_STATE` → `ERR_LOCAL_COMMUNITY_HAS_NO_SIGNER_IN_INTERNAL_STATE`
- [ ] `ERR_SUB_STATE_LOCKED` → `ERR_COMMUNITY_STATE_LOCKED`
- [ ] `ERR_SUB_CREATION_LOCKED` → `ERR_COMMUNITY_CREATION_LOCKED`
- [ ] `ERR_SUB_ALREADY_STARTED` → `ERR_COMMUNITY_ALREADY_STARTED`
- [ ] `ERR_LOCAL_SUBPLEBBIT_PRODUCED_INVALID_RECORD` → `ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_RECORD`
- [ ] `ERR_LOCAL_SUBPLEBBIT_RECORD_TOO_LARGE` → `ERR_LOCAL_COMMUNITY_RECORD_TOO_LARGE`
- [ ] `ERR_CAN_NOT_LOAD_DB_IF_LOCAL_SUB_ALREADY_STARTED_IN_ANOTHER_PROCESS` → `ERR_CAN_NOT_LOAD_DB_IF_LOCAL_COMMUNITY_ALREADY_STARTED_IN_ANOTHER_PROCESS`
- [ ] `ERR_CAN_NOT_EDIT_A_LOCAL_SUBPLEBBIT_THAT_IS_ALREADY_STARTED_IN_ANOTHER_PROCESS` → `ERR_CAN_NOT_EDIT_A_LOCAL_COMMUNITY_THAT_IS_ALREADY_STARTED_IN_ANOTHER_PROCESS`
- [ ] `CAN_NOT_LOAD_LOCAL_SUBPLEBBIT_IF_DB_DOES_NOT_EXIST` → `CAN_NOT_LOAD_LOCAL_COMMUNITY_IF_DB_DOES_NOT_EXIST`
- [ ] `ERR_SUB_START_FAILED_UNKNOWN_ERROR` → `ERR_COMMUNITY_START_FAILED_UNKNOWN_ERROR`
- [ ] `ERR_SUB_ALREADY_STARTED_IN_SAME_PLEBBIT_INSTANCE` → `ERR_COMMUNITY_ALREADY_STARTED_IN_SAME_PKC_INSTANCE`
- [ ] `ERR_SUB_COMMENT_TIMESTAMP_IS_EARLIER_THAN_PARENT` → `ERR_COMMUNITY_COMMENT_TIMESTAMP_IS_EARLIER_THAN_PARENT`
- [ ] `ERR_SUB_PUBLICATION_PARENT_CID_NOT_DEFINED` → `ERR_COMMUNITY_PUBLICATION_PARENT_CID_NOT_DEFINED`
- [ ] `ERR_PUBLICATION_INVALID_SUBPLEBBIT_ADDRESS` → `ERR_PUBLICATION_INVALID_COMMUNITY_ADDRESS`
- [ ] `ERR_SUB_PUBLICATION_PARENT_HAS_BEEN_REMOVED` → `ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_REMOVED`
- [ ] `ERR_SUB_PUBLICATION_PARENT_HAS_BEEN_DELETED` → `ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_DELETED`
- [ ] `ERR_SUB_PUBLICATION_POST_HAS_BEEN_DELETED` → `ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_DELETED`
- [ ] `ERR_SUB_PUBLICATION_POST_HAS_BEEN_REMOVED` → `ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_REMOVED`
- [ ] `ERR_SUB_PUBLICATION_POST_IS_LOCKED` → `ERR_COMMUNITY_PUBLICATION_POST_IS_LOCKED`
- [ ] `ERR_SUB_FAILED_TO_DECRYPT_PUBSUB_MSG` → `ERR_COMMUNITY_FAILED_TO_DECRYPT_PUBSUB_MSG`
- [ ] `ERR_SUB_COMMENT_MOD_CAN_NOT_LOCK_REPLY` → `ERR_COMMUNITY_COMMENT_MOD_CAN_NOT_LOCK_REPLY`
- [ ] `ERR_SUB_COMMENT_EDIT_UNAUTHORIZED_FIELD` → `ERR_COMMUNITY_COMMENT_EDIT_UNAUTHORIZED_FIELD`
- [ ] `ERR_SUBPLEBBIT_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS` → `ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS`
- [ ] `ERR_SUBPLEBBIT_EDIT_ATTEMPTED_TO_MODIFY_SUB_WITHOUT_BEING_OWNER_OR_ADMIN` → `ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_COMMUNITY_WITHOUT_BEING_OWNER_OR_ADMIN`
- [ ] `ERR_SUBPLEBBIT_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS` → `ERR_COMMUNITY_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS`
- [ ] `ERR_RPC_CLIENT_ATTEMPTING_TO_START_A_REMOTE_SUB` → `ERR_RPC_CLIENT_ATTEMPTING_TO_START_A_REMOTE_COMMUNITY`
- [ ] `ERR_RPC_CLIENT_TRYING_TO_STOP_SUB_THAT_IS_NOT_RUNNING` → `ERR_RPC_CLIENT_TRYING_TO_STOP_COMMUNITY_THAT_IS_NOT_RUNNING`
- [ ] `ERR_RPC_CLIENT_TRYING_TO_STOP_REMOTE_SUB` → `ERR_RPC_CLIENT_TRYING_TO_STOP_REMOTE_COMMUNITY`
- [ ] `ERR_RPC_CLIENT_TRYING_TO_EDIT_REMOTE_SUB` → `ERR_RPC_CLIENT_TRYING_TO_EDIT_REMOTE_COMMUNITY`
- [ ] `ERR_RPC_CLIENT_TRYING_TO_DELETE_REMOTE_SUB` → `ERR_RPC_CLIENT_TRYING_TO_DELETE_REMOTE_COMMUNITY`

**PLEBBIT → PKC error codes:**
- [ ] `ERR_PLEBBIT_MISSING_NATIVE_FUNCTIONS` → `ERR_PKC_MISSING_NATIVE_FUNCTIONS`
- [ ] `ERR_PLEBBIT_OPTION_NOT_ACCEPTED` → `ERR_PKC_OPTION_NOT_ACCEPTED`
- [ ] `ERR_PLEBBIT_SQLITE_LONG_TERM_STORAGE_KEYV_ERROR` → `ERR_PKC_SQLITE_LONG_TERM_STORAGE_KEYV_ERROR`
- [ ] `ERR_PLEBBIT_IS_DESTROYED` → `ERR_PKC_IS_DESTROYED`
- [ ] `ERR_INVALID_CREATE_PLEBBIT_WS_SERVER_OPTIONS_SCHEMA` → `ERR_INVALID_CREATE_PKC_WS_SERVER_OPTIONS_SCHEMA`
- [ ] `ERR_INVALID_CREATE_PLEBBIT_ARGS_SCHEMA` → `ERR_INVALID_CREATE_PKC_ARGS_SCHEMA`

### 10.3 Index Exports (src/index.ts)
- [ ] `plebbitJsChallenges` export → `pkcJsChallenges`

### 10.4 Logger Prefixes
Replace all logger prefixes:
- [ ] `Logger("plebbit-js:...")` → `Logger("pkc-js:...")` (48+ prefixes across src/)
- [ ] `Logger("plebbit-js-rpc:...")` → `Logger("pkc-js-rpc:...")` (RPC server uses a different prefix than the main codebase)
- [ ] Examples:
  - `"plebbit-js:PlebbitRpcClient"` → `"pkc-js:PKCRpcClient"`
  - `"plebbit-js:plebbit:client-manager"` → `"pkc-js:pkc:client-manager"`
  - `"plebbit-js:listSubplebbitsSync"` → `"pkc-js:listCommunitiesSync"`
  - `"plebbit-js-rpc:plebbit-ws-server"` → `"pkc-js-rpc:pkc-ws-server"`

---

## Phase 11: Signer & Signature Functions

### 11.1 Function Names (src/signer/signatures.ts)
- [ ] `signSubplebbitEdit` → `signCommunityEdit`
- [ ] `verifySubplebbitEdit` → `verifyCommunityEdit`
- [ ] `verifySubplebbit` → `verifyCommunity`
- [ ] `signSubplebbit` → `signCommunity`

### 11.2 Type Parameters
- [ ] All function parameters with `plebbit: Plebbit` → `pkc: PKC`
- [ ] All `subplebbit` parameters → `community`

---

## Phase 12: Test Files

### 12.1 Test File Renaming
Rename all test files with "subplebbit" or "plebbit" in the name. Files without "subplebbit"/"plebbit" in the filename only need content updates (Phase 12.2), not file renaming — they are listed for completeness under their directory.

**test/node/subplebbit/** (34 files — directory moves to test/node/community/)
- [ ] `create.subplebbit.test.ts` → `create.community.test.ts`
- [ ] `delete.subplebbit.test.ts` → `delete.community.test.ts`
- [ ] `edit.subplebbit.test.ts` → `edit.community.test.ts`
- [ ] `start.subplebbit.test.ts` → `start.community.test.ts`
- [ ] `stop.subplebbit.test.ts` → `stop.community.test.ts`
- [ ] `state.subplebbit.test.ts` → `state.community.test.ts`
- [ ] `update.subplebbit.test.ts` → `update.community.test.ts`
- [ ] `editable.subplebbit.test.ts` → `editable.community.test.ts`
- [ ] `error.start.subplebbit.test.ts` → `error.start.community.test.ts`
- [ ] `local.publishing.subplebbit.test.ts` → `local.publishing.community.test.ts`
- [ ] `misc.subplebbit.test.ts` → `misc.community.test.ts`
- [ ] `updateCid.subplebbit.test.ts` → `updateCid.community.test.ts`
- [ ] `unique.migration.db.subplebbit.test.ts` → `unique.migration.db.community.test.ts`
- [ ] `db.subplebbit.test.ts` → `db.community.test.ts`
- [ ] `commentsToUpdate.db.subplebbit.test.ts` → `commentsToUpdate.db.community.test.ts`
- [ ] `parsing.db.subplebbit.test.ts` → `parsing.db.community.test.ts`
- [ ] `authorPublicationCounts.db.subplebbit.test.ts` → `authorPublicationCounts.db.community.test.ts`
- [ ] `queryComment.quotedCids.db.subplebbit.test.ts` → `queryComment.quotedCids.db.community.test.ts`
- [ ] `startedState.subplebbit.test.ts` → `startedState.community.test.ts`
- [ ] `stats.subplebbit.test.ts` → `stats.community.test.ts`
- [ ] `updatingstate.subplebbit.test.ts` → `updatingstate.community.test.ts`
- [ ] `republishing.subplebbit.test.ts` → `republishing.community.test.ts`
- [ ] `postUpdates.subplebbit.test.ts` → `postUpdates.community.test.ts`
- [ ] `gateway.loading.subplebbit.test.ts` → `gateway.loading.community.test.ts`
- [ ] `commentUpdate.fields.db.subplebbit.test.ts` → `commentUpdate.fields.db.community.test.ts`
- [ ] `unique.publishing.subplebbit.test.ts` → `unique.publishing.community.test.ts`
- [ ] `garbage.collection.subplebbit.test.ts` → `garbage.collection.community.test.ts`
- [ ] `quotedCids.pendingApproval.subplebbit.test.ts` → `quotedCids.pendingApproval.community.test.ts`
- [ ] `eth-bso-equivalence.test.ts` (content updates only — no "subplebbit" in filename)
- [ ] `malformed-gateway-headers.test.ts` (content updates only)
- [ ] `maximum.depth.test.ts` (content updates only)
- [ ] `mirror-client-mismatch.test.ts` (content updates only)
- [ ] `multiplegateways.update.test.ts` (content updates only)
- [ ] `unsupported-tld-rejection.test.ts` (content updates only)

**test/node/subplebbit/ipns/**
- [ ] `resolve.ipns.subplebbit.test.ts` → `resolve.ipns.community.test.ts`

**test/node/subplebbit/modqueue/**
- [ ] `modqueue.subplebbit.test.ts` → `modqueue.community.test.ts`
- [ ] `purge.expire.rejection.modqueue.subplebbit.test.ts` → `purge.expire.rejection.modqueue.community.test.ts`
- [ ] `approved.modqueue.subplebbit.test.ts` → `approved.modqueue.community.test.ts`
- [ ] `limit.modqueue.subplebbit.test.ts` → `limit.modqueue.community.test.ts`
- [ ] `page.modqueue.subplebbit.test.ts` → `page.modqueue.community.test.ts`
- [ ] `pendingapproval.modqueue.subplebbit.test.ts` → `pendingapproval.modqueue.community.test.ts`
- [ ] `rejection.modqueue.subplebbit.test.ts` → `rejection.modqueue.community.test.ts`

**test/node/subplebbit/page-generation/**
- [ ] `chunking.page.generation.subplebbit.test.ts` → `chunking.page.generation.community.test.ts`
- [ ] `edgecases.page.generation.subplebbit.test.ts` → `edgecases.page.generation.community.test.ts`

**test/node/subplebbit/challenges/** (directory moves to test/node/community/challenges/)
- [ ] `challenges.settings.test.ts` (content updates only)
- [ ] `path.challenge.test.ts` (content updates only)
- [ ] `pseudonymity-challenge-exclusion.test.ts` (content updates only)

**test/node/subplebbit/pubsub-msgs/** (directory moves to test/node/community/pubsub-msgs/)
- [ ] `properties.pubsub.test.ts` (content updates only)

**test/node/subplebbit/features/** (31 files — directory moves to test/node/community/features/)
- [ ] `per-post.pseudonymityMode.subplebbit.features.test.ts` → `per-post.pseudonymityMode.community.features.test.ts`
- [ ] `per-reply.pseudonymityMode.subplebbit.features.test.ts` → `per-reply.pseudonymityMode.community.features.test.ts`
- [ ] `per-author.pseudonymityMode.subplebbit.features.test.ts` → `per-author.pseudonymityMode.community.features.test.ts`
- [ ] `authorFlairs.subplebbit.features.test.ts` → `authorFlairs.community.features.test.ts`
- [ ] `noAudio.subplebbit.features.test.ts` → `noAudio.community.features.test.ts`
- [ ] `noAudioReplies.subplebbit.features.test.ts` → `noAudioReplies.community.features.test.ts`
- [ ] `noDownvotes.subplebbit.features.test.ts` → `noDownvotes.community.features.test.ts`
- [ ] `noImages.subplebbit.features.test.ts` → `noImages.community.features.test.ts`
- [ ] `noImageReplies.subplebbit.features.test.ts` → `noImageReplies.community.features.test.ts`
- [ ] `noMarkdownAudio.subplebbit.features.test.ts` → `noMarkdownAudio.community.features.test.ts`
- [ ] `noMarkdownImages.subplebbit.features.test.ts` → `noMarkdownImages.community.features.test.ts`
- [ ] `noMarkdownVideos.subplebbit.features.test.ts` → `noMarkdownVideos.community.features.test.ts`
- [ ] `noNestedReplies.subplebbit.features.test.ts` → `noNestedReplies.community.features.test.ts`
- [ ] `noPostDownvotes.subplebbit.features.test.ts` → `noPostDownvotes.community.features.test.ts`
- [ ] `noPostUpvotes.subplebbit.features.test.ts` → `noPostUpvotes.community.features.test.ts`
- [ ] `noReplyDownvotes.subplebbit.features.test.ts` → `noReplyDownvotes.community.features.test.ts`
- [ ] `noReplyUpvotes.subplebbit.features.test.ts` → `noReplyUpvotes.community.features.test.ts`
- [ ] `noSpoilers.subplebbit.features.test.ts` → `noSpoilers.community.features.test.ts`
- [ ] `noSpoilerReplies.subplebbit.features.test.ts` → `noSpoilerReplies.community.features.test.ts`
- [ ] `noUpvotes.subplebbit.features.test.ts` → `noUpvotes.community.features.test.ts`
- [ ] `noVideos.subplebbit.features.test.ts` → `noVideos.community.features.test.ts`
- [ ] `noVideoReplies.subplebbit.features.test.ts` → `noVideoReplies.community.features.test.ts`
- [ ] `postFlairs.subplebbit.features.test.ts` → `postFlairs.community.features.test.ts`
- [ ] `requireAuthorFlairs.subplebbit.features.test.ts` → `requireAuthorFlairs.community.features.test.ts`
- [ ] `requirePostFlairs.subplebbit.features.test.ts` → `requirePostFlairs.community.features.test.ts`
- [ ] `requirePostLink.subplebbit.features.test.ts` → `requirePostLink.community.features.test.ts`
- [ ] `requirePostLinkIsMedia.subplebbit.features.test.ts` → `requirePostLinkIsMedia.community.features.test.ts`
- [ ] `requireReplyLink.subplebbit.features.test.ts` → `requireReplyLink.community.features.test.ts`
- [ ] `requireReplyLinkIsMedia.subplebbit.features.test.ts` → `requireReplyLinkIsMedia.community.features.test.ts`
- [ ] `safeForWork.subplebbit.features.test.ts` → `safeForWork.community.features.test.ts`

**test/node/plebbit/** (directory to be renamed to test/node/pkc/)
- [ ] `plebbit.test.ts` → `pkc.test.ts`
- [ ] `validatecomment.plebbit.test.ts` → `validatecomment.pkc.test.ts`
- [ ] `started-subplebbits.test.ts` → `started-communities.test.ts`
- [ ] `plebbit-settings-challenges.test.ts` → `pkc-settings-challenges.test.ts`
- [ ] `plebbit-settings-challenges-rpc.test.ts` → `pkc-settings-challenges-rpc.test.ts`
- [ ] `hanging.plebbit.test.ts` → `hanging.pkc.test.ts`

**test/node-and-browser/subplebbit/** (13 files — directory moves to test/node-and-browser/community/)
- [ ] `state.subplebbit.test.ts` → `state.community.test.ts`
- [ ] `backward.compatibility.subplebbit.test.ts` → `backward.compatibility.community.test.ts`
- [ ] `updateCid.subplebbit.test.ts` → `updateCid.community.test.ts`
- [ ] `getsubplebbit.plebbit.test.ts` → `getcommunity.pkc.test.ts`
- [ ] `createsubplebbit.plebbit.test.ts` → `createcommunity.pkc.test.ts`
- [ ] `update.subplebbit.test.ts` → `update.community.test.ts`
- [ ] `stop.subplebbit.test.ts` → `stop.community.test.ts`
- [ ] `ipfsgateways.clients.test.ts` (content updates only)
- [ ] `libp2pjs.kuboRpc.clients.test.ts` (content updates only)
- [ ] `nameresolvers.clients.test.ts` (content updates only)
- [ ] `rpc.clients.test.ts` (content updates only)
- [ ] `updatingstate.test.ts` (content updates only)
- [ ] `waiting-retry.update.test.ts` (content updates only)

**test/node-and-browser/subplebbit/ipns/**
- [ ] `ipns.fields.subplebbit.test.ts` → `ipns.fields.community.test.ts`

**test/node-and-browser/subplebbit/posts/** (directory moves to test/node-and-browser/community/posts/)
- [ ] `pages.posts.test.ts` (content updates only)
- [ ] `ipfsgateways.clients.posts.test.ts` (content updates only)
- [ ] `rpc.clients.posts.test.ts` (content updates only)
- [ ] `libp2pjs.kuboRpc.clients.posts.test.ts` (content updates only)

**test/node-and-browser/subplebbit/modqueue/** (directory moves to test/node-and-browser/community/modqueue/)
- [ ] `pages.modqueue.test.ts` (content updates only)
- [ ] `ipfsgateways.clients.modqueue.test.ts` (content updates only)
- [ ] `rpc.clients.modqueue.test.ts` (content updates only)
- [ ] `libp2pjs.kuboRpc.clients.modqueue.test.ts` (content updates only)

**test/node-and-browser/plebbit/** (directory to be renamed to test/node-and-browser/pkc/)
- [ ] `plebbit.test.ts` → `pkc.test.ts`
- [ ] `_updatingSubplebbits.plebbit.test.ts` → `_updatingCommunities.pkc.test.ts`
- [ ] `_updatingComments.plebbit.test.ts` → `_updatingComments.pkc.test.ts`
- [ ] `fetchCid.plebbit.test.ts` → `fetchCid.pkc.test.ts`
- [ ] `test.configs.plebbit.test.ts` → `test.configs.pkc.test.ts`

**test/node-and-browser/signatures/**
- [ ] `subplebbit.test.ts` → `community.test.ts`
- [ ] `pubsub.messages.test.ts` (content updates only)
- [ ] `comment.test.ts` (content updates only)
- [ ] `edit.comment.test.ts` (content updates only)
- [ ] `vote.test.ts` (content updates only)
- [ ] `pages.test.ts` (content updates only)

**test/node-and-browser/publications/subplebbit-edit/** (directory moves to test/node-and-browser/publications/community-edit/)
- [ ] `subplebbit.edit.publication.test.ts` → `community.edit.publication.test.ts`

**test/node-and-browser/publications/comment/**
- [ ] `getcomment.plebbit.test.ts` → `getcomment.pkc.test.ts`

**test/browser/**
- [ ] `plebbit.test.ts` → `pkc.test.ts`

**test/server/**
- [ ] `plebbit-ws-server.js` → `pkc-ws-server.js`

### 12.2 Test Content Updates
- [ ] Update all test imports to use new module paths
- [ ] Update all test assertions referencing old names
- [ ] Update fixture references

### 12.3 Test Fixtures (test/fixtures/)
- [ ] `test/fixtures/signatures/subplebbit/` → `test/fixtures/signatures/community/`
- [ ] Update JSON fixture files:
  - `valid_subplebbit_ipfs.json` → `valid_community_ipfs.json`
  - `valid_subplebbit_jsonfied.json` → `valid_community_jsonfied.json`
  - Update content within fixtures to use new property names

### 12.4 Test Configuration
- [ ] `test/run-test-config.js` - Update PLEBBIT_CONFIGS → PKC_CONFIGS
- [ ] Update environment variable references

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
- [ ] **IMPORTANT:** Need to migrate existing DNS TXT records from old names (`subplebbit-address`, `plebbit-author-address`) to single `bitsocial` record — this is documented by `@bitsocial/bso-resolver`, not pkc-js
- [ ] Document migration process for users with existing records
- [ ] Resolver plugins (e.g., `@bitsocial/bso-resolver`) may choose to support both old and new record names during transition period

### 13.4 Storage Cache Keys
Domain resolution cache keys are removed from pkc-js core (resolution moves to external resolvers):
- [x] Remove domain resolution cache logic from `src/clients/base-client-manager.ts` (cache keys like `${domainAddress}_subplebbit-address`) — resolvers now manage their own caching via optional `dataPath` field in `NameResolverSchema`

---

## Phase 14: Data Migration Code

### 14.1 Storage Path Migration
- [ ] Change default `dataPath` from `~/.plebbit/` to `~/.pkc/` in pkc-js
- [ ] Document that `subplebbits/` → `communities/` directory rename is needed
- [ ] Document that `.plebbit/` → `.pkc/` directory rename is needed
- [ ] Note: Actual migration of existing directories should be implemented in plebbit-cli and desktop apps, NOT in pkc-js
- [ ] Create migration documentation for downstream applications

### 14.2 DNS Record Migration
- [ ] Document process for migrating DNS TXT records
- [ ] Consider adding temporary support for both old and new record names

### 14.3 Database Schema Migration
- [ ] Add `communityPublicKey` and `communityName` columns to publication tables
- [ ] Keep existing `subplebbitAddress` column **forever** but make it **nullable** (`subplebbitAddress TEXT` instead of `TEXT NOT NULL`). Old rows retain their value; new publications set it to `NULL` and use `communityPublicKey`/`communityName` instead.
- [ ] Bump DB version, add migration logic (ALTER TABLE to add new columns + make `subplebbitAddress` nullable)
- [ ] Backfill `communityPublicKey` from `subplebbitAddress` for existing records (IPNS key → `communityPublicKey` directly; domain → from community context)
- [ ] Add parsing test in `test/node/subplebbit/parsing.db.subplebbit.test.ts` per AGENTS.md
- [ ] Add integration test for `dbHandler.queryComment` returning proper JSON value (not string) for new columns

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
- [ ] `docs/addresses.md`
- [ ] `docs/building.md`
- [ ] `docs/clients.md`
- [ ] `docs/cross-platform-native-functions.md`
- [ ] `docs/encryption.md`
- [ ] `docs/ens.md`
- [ ] `docs/nft.md`
- [ ] `docs/signatures.md`
- [ ] `docs/testing.md`
- [ ] `docs/verifying-publications.md`

### 15.2 RPC Documentation
- [ ] `src/rpc/README.md`
- [ ] `src/rpc/EXPORT_SUBPLEBBIT_SPEC.md` → `src/rpc/EXPORT_COMMUNITY_SPEC.md`

---

## Phase 16: GitHub & CI/CD

### 16.1 GitHub Workflows (.github/workflows/)
- [ ] `CI.yml` - Update references
- [ ] `CI-build.yml`
- [ ] `CI-windows-test.yml`
- [ ] `CI-alerts.yml`
- [ ] `CI-plebbit-protocol-test.yml` → `CI-pkc-protocol-test.yml`
- [ ] `CI-plebbit-react-hooks.yml` → Rename if needed
- [ ] `CI-plebbit-js-benchmarks.yml` → `CI-pkc-js-benchmarks.yml`

### 16.2 Repository Rename (External)
- [ ] GitHub repository: `plebbit/plebbit-js` → Consider new org/repo name
- [ ] Update all workflow URLs

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
| Phase 1: Web3 Modularization | [~] In Progress | Name resolver done; challenge cleanup done; `resolveAuthorName` renamed; exported challenge types done; runtime author computation and `author.nameResolved` follow-up done; `nameResolved` tests added; RPC challenge verification wrapper refactored |
| Phase 2: Package Config | [ ] Not Started | |
| Phase 3: Directory Structure | [ ] Not Started | |
| Phase 4: Source Files | [ ] Not Started | |
| Phase 5: Import Paths | [ ] Not Started | |
| Phase 6: Classes & Types | [ ] Not Started | |
| Phase 7: Schemas | [ ] Not Started | |
| Phase 8: API Methods | [ ] Not Started | |
| Phase 9: RPC Methods | [ ] Not Started | |
| Phase 10: Errors & Logging | [ ] Not Started | |
| Phase 11: Signer Functions | [ ] Not Started | |
| Phase 12: Test Files | [ ] Not Started | |
| Phase 13: DNS & Protocol | [~] Partially Done | DNS TXT lookups + cache logic removed from core; migration docs not done |
| Phase 14: Data Migration | [ ] Not Started | |
| Phase 14.3: DB Schema Migration | [ ] Not Started | New columns, version bump |
| Phase 14.4: External Apps | [ ] Not Started | plebbit-cli, desktop apps |
| Phase 15: Documentation | [ ] Not Started | |
| Phase 16: GitHub & CI/CD | [ ] Not Started | |
| Phase 17: Build & Verify | [ ] Not Started | |

---

## External Repositories Requiring Changes

These repositories are outside plebbit-js but will need coordinated updates:

| Repository | Changes Needed | Status |
|------------|---------------|--------|
| @plebbit/plebbit-logger | Rename to @pkc/pkc-logger (after pkc-js rename) | [ ] Not Started |
| @plebbit/proper-lockfile | Rename to @pkc/proper-lockfile (after pkc-js rename) | [ ] Not Started |
| plebbit-cli | Directory migration: `.plebbit/` → `.pkc/` and `subplebbits/` → `communities/`, API updates, install name resolvers | [ ] Not Started |
| Desktop apps | Directory migration: `.plebbit/` → `.pkc/` and `subplebbits/` → `communities/`, API updates, install name resolvers | [ ] Not Started |
| plebbit-js-benchmarks | Rename repo to pkc-js-benchmarks, update all plebbit/subplebbit references | [ ] Not Started |
| plebbit-protocol-test | Rename repo to pkc-protocol-test, update wire format test fixtures for new field names, add backward compat tests for old records | [ ] Not Started |
| plebbit-react-hooks | Update all API references (method names, type imports, event names). Depends on pkc-js rename completing first | [ ] Not Started |
| DNS TXT records | Migrate `subplebbit-address` and `plebbit-author-address` → single `bitsocial` record | [ ] Not Started |

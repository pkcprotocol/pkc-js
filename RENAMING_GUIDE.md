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

- [ ] Re-review the current codebase and update this guide before starting Phase 1, since this document was written a while ago and likely misses newer changes.

---

## Phase 1: Package Configuration & Project Files

### 1.1 Package Identity
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

### 1.2 External Dependencies (Document for Later)
The following dependencies are in the @plebbit namespace and need separate repository work (rename AFTER pkc-js rename):
- [ ] `@plebbit/plebbit-logger` - Note: Requires separate repo rename
- [ ] `@plebbit/proper-lockfile` - Note: Requires separate repo rename

### 1.2.1 Web3 Dependencies to Remove
These dependencies move to external resolver/challenge packages:
- [ ] Remove `viem` (moves to @bitsocial/resolver-bso and @bitsocial/challenge-evm-contract)
- [ ] Remove `ethers` (moves to @bitsocial/resolver-bso)
- [ ] Remove `@bonfida/spl-name-service` if present (no .sol support)
- [ ] Remove `@solana/web3.js` if present (no .sol support)

### 1.3 RPC Package Configuration
- [ ] **rpc/package.json** - Update keywords
  - `"keywords": ["plebbit", "subplebbit"]` → `"keywords": ["pkc", "community"]`

### 1.4 Root Files
- [ ] **README.md** - Complete rewrite
  - Replace all "plebbit" → "pkc" (case-sensitive variations)
  - Replace all "subplebbit" → "community"
  - Replace all "Subplebbit" → "Community"
  - Update GitHub URLs if moving repos

- [ ] **CLAUDE.md** / **AGENTS.md** - Update references

- [ ] **project.json** - Update project metadata

---

## Phase 2: Directory Structure Renaming

### 2.1 Source Directories
- [ ] `src/plebbit/` → `src/pkc/`
- [ ] `src/subplebbit/` → `src/community/`
- [ ] `src/publications/subplebbit-edit/` → `src/publications/community-edit/`
- [ ] `src/runtime/node/subplebbit/` → `src/runtime/node/community/`
- [ ] `src/runtime/browser/subplebbit/` → `src/runtime/browser/community/`
- [ ] `src/rpc/src/lib/plebbit-js/` → `src/rpc/src/lib/pkc-js/`
- [ ] `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/` → `src/runtime/node/community/challenges/pkc-js-challenges/`

### 2.2 Test Directories
- [ ] `test/node/subplebbit/` → `test/node/community/`
- [ ] `test/node/plebbit/` → `test/node/pkc/`
- [ ] `test/node-and-browser/subplebbit/` → `test/node-and-browser/community/`
- [ ] `test/node-and-browser/plebbit/` → `test/node-and-browser/pkc/`
- [ ] `test/fixtures/signatures/subplebbit/` → `test/fixtures/signatures/community/`

### 2.3 Data Storage Directories (Breaking Change)
- [ ] Default data path changes: `subplebbits/` → `communities/`
- [ ] Note: Migration code for old paths should be implemented in user-facing clients (plebbit-cli, desktop apps), NOT in pkc-js itself

---

## Phase 3: Source File Renaming

### 3.1 Plebbit → PKC Files
- [ ] `src/plebbit/plebbit.ts` → `src/pkc/pkc.ts`
- [ ] `src/plebbit/plebbit-with-rpc-client.ts` → `src/pkc/pkc-with-rpc-client.ts`
- [ ] `src/plebbit/plebbit-client-manager.ts` → `src/pkc/pkc-client-manager.ts`
- [ ] `src/plebbit/plebbit-clients.ts` → `src/pkc/pkc-clients.ts`
- [ ] `src/clients/rpc-client/plebbit-rpc-client.ts` → `src/clients/rpc-client/pkc-rpc-client.ts`
- [ ] `src/clients/plebbit-typed-emitter.ts` → `src/clients/pkc-typed-emitter.ts`
- [ ] `src/plebbit-error.ts` → `src/pkc-error.ts`
- [ ] `src/helia/helia-for-plebbit.ts` → `src/helia/helia-for-pkc.ts`
- [ ] `src/rpc/src/lib/plebbit-js/plebbit-js-mock.ts` → `src/rpc/src/lib/pkc-js/pkc-js-mock.ts`
- [ ] `src/version.ts` - Update USER_AGENT string:
  - `/plebbit-js:${version}/` → `/pkc-js:${version}/`

### 3.2 Subplebbit → Community Files
- [ ] `src/subplebbit/remote-subplebbit.ts` → `src/community/remote-community.ts`
- [ ] `src/subplebbit/rpc-remote-subplebbit.ts` → `src/community/rpc-remote-community.ts`
- [ ] `src/subplebbit/rpc-local-subplebbit.ts` → `src/community/rpc-local-community.ts`
- [ ] `src/subplebbit/subplebbit-clients.ts` → `src/community/community-clients.ts`
- [ ] `src/subplebbit/subplebbit-client-manager.ts` → `src/community/community-client-manager.ts`
- [ ] `src/publications/subplebbit-edit/subplebbit-edit.ts` → `src/publications/community-edit/community-edit.ts`
- [ ] `src/runtime/node/subplebbit/local-subplebbit.ts` → `src/runtime/node/community/local-community.ts`
- [ ] `src/runtime/node/subplebbit/db-handler.ts` → `src/runtime/node/community/db-handler.ts`
- [ ] `src/runtime/node/subplebbit/page-generator.ts` → `src/runtime/node/community/page-generator.ts`
- [ ] `src/runtime/browser/subplebbit/local-subplebbit.ts` → `src/runtime/browser/community/local-community.ts`

### 3.3 Challenge System Files
- [ ] `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/index.ts` - Export rename:
  - `plebbitJsChallenges` → `pkcJsChallenges`
- [ ] `src/runtime/browser/subplebbit/challenges/` → `src/runtime/browser/community/challenges/`

### 3.4 Test File Renaming

**Note:** All test files should use the `.test.ts` TypeScript extension (see `test/TYPESCRIPT_MIGRATION_PROGRESS.md`).

All test files in test/node/subplebbit/ and test/node-and-browser/subplebbit/:
- [ ] `*.subplebbit.test.ts` → `*.community.test.ts`

**test/node/plebbit/** (directory to be renamed to test/node/pkc/):
- [ ] `plebbit.test.ts` → `pkc.test.ts`
- [ ] `validatecomment.plebbit.test.ts` → `validatecomment.pkc.test.ts`
- [ ] `started-subplebbits.test.ts` → `started-communities.test.ts`

**test/node-and-browser/plebbit/** (directory to be renamed to test/node-and-browser/pkc/):
- [ ] `_updatingSubplebbits.plebbit.test.ts` → `_updatingCommunities.pkc.test.ts`

---

## Phase 4: Class, Type & Interface Renaming

### 4.1 Main Classes (src/plebbit/ → src/pkc/)
- [ ] `class Plebbit` → `class PKC`
- [ ] `class PlebbitWithRpcClient` → `class PKCWithRpcClient`
- [ ] `class PlebbitRpcClient` → `class PKCRpcClient`
- [ ] `class PlebbitTypedEmitter` → `class PKCTypedEmitter`
- [ ] `class PlebbitClientsManager` → `class PKCClientsManager`
- [ ] `class PlebbitError` → `class PKCError`
- [ ] `class PlebbitIpfsGatewayClient` → `class PKCIpfsGatewayClient`
- [ ] `class PlebbitKuboRpcClient` → `class PKCKuboRpcClient`
- [ ] `class PlebbitLibp2pJsClient` → `class PKCLibp2pJsClient`

### 4.2 Subplebbit Classes (src/subplebbit/ → src/community/)
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

### 4.3 Type Definitions (src/types.ts, src/subplebbit/types.ts)
**Plebbit types:**
- [ ] `interface PlebbitEvents` → `interface PKCEvents`
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

---

## Phase 5: Schema Renaming (Zod)

### 5.1 Main Schemas (src/schema.ts)
- [ ] `PlebbitUserOptionBaseSchema` → `PKCUserOptionBaseSchema`
- [ ] `PlebbitUserOptionsSchema` → `PKCUserOptionsSchema`
- [ ] `PlebbitParsedOptionsSchema` → `PKCParsedOptionsSchema`
- [ ] Property: `plebbitRpcClientsOptions` → `pkcRpcClientsOptions`

### 5.2 Author Schemas (src/schema/schema.ts)
- [ ] `SubplebbitAuthorSchema` → `CommunityAuthorSchema`

### 5.4 Subplebbit Schemas (src/subplebbit/schema.ts)
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
- [ ] `RpcRemoteSubplebbitUpdateEventResultSchema` → `RpcRemoteCommunityUpdateEventResultSchema`

### 5.5 RPC Client Schemas (src/clients/rpc-client/schema.ts)
- [ ] `RpcSubplebbitAddressParamSchema` → `RpcCommunityAddressParamSchema`
- [ ] `RpcSubplebbitPageParamSchema` → `RpcCommunityPageParamSchema`

### 5.6 Schema Parser Functions (src/schema/schema-util.ts)
- [ ] All `parse*PlebbitErrorIfItFails` → `parse*PKCErrorIfItFails`
- [ ] All `parse*SubplebbitSchemaWithPlebbitErrorIfItFails` → `parse*CommunitySchemaWithPKCErrorIfItFails`

---

## Phase 6: API Method & Property Renaming

### 6.1 Plebbit/PKC Class Methods
- [ ] `plebbit.createSubplebbit()` → `pkc.createCommunity()`
- [ ] `plebbit.getSubplebbit()` → `pkc.getCommunity()`
- [ ] `plebbit.listSubplebbits()` → `pkc.listCommunities()`

### 6.1.1 PlebbitWithRpcClient Internal Methods
- [ ] `_initPlebbitRpcClients()` → `_initPKCRpcClients()`

### 6.2 Plebbit/PKC Class Properties
- [ ] `plebbit.subplebbits` → `pkc.communities`
- [ ] `plebbit._updatingSubplebbits` → `pkc._updatingCommunities`
- [ ] `plebbit._startedSubplebbits` → `pkc._startedCommunities`
- [ ] `plebbit._subplebbitFsWatchAbort` → `pkc._communityFsWatchAbort`
- [ ] `plebbit.plebbitRpcClientsOptions` → `pkc.pkcRpcClientsOptions`
- [ ] `plebbit._plebbitRpcClient` → `pkc._pkcRpcClient`
- [ ] `plebbit._userPlebbitOptions` → `pkc._userPKCOptions`
- [ ] `plebbit._memCaches` (type change to PKCMemCaches)
- [ ] `plebbit.clients.plebbitRpcClients` → `pkc.clients.pkcRpcClients`

### 6.2.1 PlebbitRpcClient Internal Properties
- [ ] `PlebbitRpcClient.subplebbits` → `PKCRpcClient.communities` (array tracking subplebbit addresses received via RPC)

### 6.2.2 Utility Functions (src/runtime/node/util.ts)
- [ ] `getDefaultSubplebbitDbConfig()` → `getDefaultCommunityDbConfig()`
- [ ] `deleteOldSubplebbitInWindows()` → `deleteOldCommunityInWindows()`

### 6.2.3 RPC Schema Utility Functions (src/clients/rpc-client/rpc-schema-util.ts)
- [ ] `parseRpcSubplebbitAddressParam()` → `parseRpcCommunityAddressParam()`
- [ ] `parseRpcSubplebbitPageParam()` → `parseRpcCommunityPageParam()`

### 6.2.4 RPC Client Types (src/clients/rpc-client/types.ts)
- [ ] `SubplebbitAddressRpcParam` → `CommunityAddressRpcParam`
- [ ] `SubplebbitPageRpcParam` → `CommunityPageRpcParam`

### 6.3 Publication Properties
**See [NAMES_AND_PUBLIC_KEY_PROPOSAL.md](./NAMES_AND_PUBLIC_KEY_PROPOSAL.md) for wire format decisions.**
- [ ] `publication.subplebbitAddress` → replace with wire fields `communityPublicKey` + `communityName`; `communityAddress` is instance-only (computed as `communityName || communityPublicKey`)
- [ ] `publication.shortSubplebbitAddress` → `publication.shortCommunityAddress`

### 6.3.1 Author Properties (src/schema/schema.ts)
- [ ] `author.subplebbit` → `author.community` (property on AuthorIpfsSchema containing community-specific author data)

### 6.4 Timeout Keys (src/plebbit/plebbit.ts)
- [ ] `"subplebbit-ipns"` → `"community-ipns"`
- [ ] `"subplebbit-ipfs"` → `"community-ipfs"`

### 6.5 State Machine States (Public API - affects downstream consumers)
State strings emitted via `statechange` and `publishingstatechange` events:
- [ ] `"resolving-subplebbit-address"` → `"resolving-community-address"` (src/publications/types.ts, src/publications/comment/types.ts)
- [ ] `"fetching-subplebbit-ipns"` → `"fetching-community-ipns"`
- [ ] `"fetching-subplebbit-ipfs"` → `"fetching-community-ipfs"`
- [ ] Chain provider state: `"resolving-subplebbit-address"` → `"resolving-community-address"` (src/clients/chain-provider-client.ts)

---

## Phase 7: RPC Method Renaming

### 7.1 RPC Server Methods (src/rpc/src/index.ts)
- [ ] `getSubplebbitPage` → `getCommunityPage`
- [ ] `createSubplebbit` → `createCommunity`
- [ ] `startSubplebbit` → `startCommunity`
- [ ] `stopSubplebbit` → `stopCommunity`
- [ ] `editSubplebbit` → `editCommunity`
- [ ] `deleteSubplebbit` → `deleteCommunity`
- [ ] `subplebbitsSubscribe` → `communitiesSubscribe`
- [ ] `subplebbitUpdateSubscribe` → `communityUpdateSubscribe`
- [ ] `publishSubplebbitEdit` → `publishCommunityEdit`

### 7.2 RPC Event Names
- [ ] `"subplebbitschange"` → `"communitieschange"`
- [ ] `"subplebbitUpdateNotification"` → `"communityUpdateNotification"`
- [ ] `"subplebbitsNotification"` → `"communitiesNotification"`
- [ ] `"publishSubplebbitEditNotification"` → `"publishCommunityEditNotification"`

### 7.3 RPC Parameter Names (Wire Protocol)
- [ ] `RpcSubplebbitPageParamSchema.subplebbitAddress` → `communityAddress` (src/clients/rpc-client/schema.ts)
- [ ] `getSubplebbitPage` params: `{ subplebbitAddress }` → `{ communityAddress }` (src/rpc/src/index.ts)
- [ ] `getCommentPage` params: `{ subplebbitAddress }` → `{ communityAddress }` (src/rpc/src/index.ts)

---

## Phase 8: DNS & Protocol Changes (Breaking)

### 8.1 DNS TXT Record Names
Replace both `"plebbit-author-address"` and `"subplebbit-address"` with a single `"bitsocial"` TXT record key (see Q2 resolution). Value = IPNS public key.
- [ ] `"plebbit-author-address"` → removed (replaced by `"bitsocial"` record)
- [ ] `"subplebbit-address"` → removed (replaced by `"bitsocial"` record)
- [ ] Add `"bitsocial"` TXT record lookup (src/clients/base-client-manager.ts)

### 8.2 Wallet Signature Domain Separator
The EVM contract call challenge uses a domain separator in the message to be signed:
- [ ] `"plebbit-author-wallet"` → `"pkc-author-wallet"` ([src/runtime/node/subplebbit/challenges/plebbit-js-challenges/evm-contract-call/index.ts:111](src/runtime/node/subplebbit/challenges/plebbit-js-challenges/evm-contract-call/index.ts#L111))

### 8.3 Migration TODO
- [ ] **IMPORTANT:** Need to migrate existing DNS TXT records from old names (`subplebbit-address`, `plebbit-author-address`) to single `bitsocial` record
- [ ] Document migration process for users with existing records
- [ ] Consider supporting both old and new record names during transition period

### 8.4 Storage Cache Keys
Domain resolution cache keys (minor - invalidating just causes re-resolution):
- [ ] `${domainAddress}_subplebbit-address` → `${domainAddress}_bitsocial` (src/clients/base-client-manager.ts:637)
- [ ] Note: Changing this will invalidate existing caches, causing one-time re-resolution

---

## Phase 9: Error Messages & Logging

### 9.1 Error Classes (src/plebbit-error.ts → src/pkc-error.ts)
- [ ] `PlebbitError` → `PKCError`
- [ ] `FailedToFetchSubplebbitFromGatewaysError` → `FailedToFetchCommunityFromGatewaysError`
- [ ] `FailedToFetchCommentIpfsFromGatewaysError` (keep as is - comment not subplebbit)
- [ ] `FailedToFetchCommentUpdateFromGatewaysError` (keep as is)
- [ ] `FailedToFetchPageIpfsFromGatewaysError` (keep as is)
- [ ] `FailedToFetchGenericIpfsFromGatewaysError` (keep as is)

### 9.2 Error Codes (src/errors.ts)

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

### 9.3 Index Exports (src/index.ts)
- [ ] `plebbitJsChallenges` export → `pkcJsChallenges`

### 9.4 Logger Prefixes
Replace all logger prefixes:
- [ ] `Logger("plebbit-js:...")` → `Logger("pkc-js:...")`
- [ ] Examples:
  - `"plebbit-js:PlebbitRpcClient"` → `"pkc-js:PKCRpcClient"`
  - `"plebbit-js:plebbit:client-manager"` → `"pkc-js:pkc:client-manager"`
  - `"plebbit-js:listSubplebbitsSync"` → `"pkc-js:listCommunitiesSync"`

---

## Phase 10: Signer & Signature Functions

### 10.1 Function Names (src/signer/signatures.ts)
- [ ] `signSubplebbitEdit` → `signCommunityEdit`
- [ ] `verifySubplebbitEdit` → `verifyCommunityEdit`
- [ ] `verifySubplebbit` → `verifyCommunity`
- [ ] `signSubplebbit` → `signCommunity`

### 10.2 Type Parameters
- [ ] All function parameters with `plebbit: Plebbit` → `pkc: PKC`
- [ ] All `subplebbit` parameters → `community`

---

## Phase 11: Test Files

### 11.1 Test File Renaming
Rename all test files with "subplebbit" in the name (48 files total):

**test/node/subplebbit/**
- [ ] `create.subplebbit.test.ts` → `create.community.test.ts`
- [ ] `delete.subplebbit.test.ts` → `delete.community.test.ts`
- [ ] `edit.subplebbit.test.ts` → `edit.community.test.ts`
- [ ] `start.subplebbit.test.ts` → `start.community.test.ts`
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
- [ ] `startedState.subplebbit.test.ts` → `startedState.community.test.ts`
- [ ] `stats.subplebbit.test.ts` → `stats.community.test.ts`
- [ ] `updatingstate.subplebbit.test.ts` → `updatingstate.community.test.ts`
- [ ] `republishing.subplebbit.test.ts` → `republishing.community.test.ts`
- [ ] `postUpdates.subplebbit.test.ts` → `postUpdates.community.test.ts`
- [ ] `gateway.loading.subplebbit.test.ts` → `gateway.loading.community.test.ts`
- [ ] `commentUpdate.fields.db.subplebbit.test.ts` → `commentUpdate.fields.db.community.test.ts`
- [ ] `unique.publishing.subplebbit.test.ts` → `unique.publishing.community.test.ts`
- [ ] `garbage.collection.subplebbit.test.ts` → `garbage.collection.community.test.ts`

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

**test/node/subplebbit/features/**
- [ ] `features.subplebbit.test.ts` → `features.community.test.ts`
- [ ] `per-post.pseudonymityMode.subplebbit.features.test.ts` → `per-post.pseudonymityMode.community.features.test.ts`
- [ ] `per-reply.pseudonymityMode.subplebbit.features.test.ts` → `per-reply.pseudonymityMode.community.features.test.ts`
- [ ] `per-author.pseudonymityMode.subplebbit.features.test.ts` → `per-author.pseudonymityMode.community.features.test.ts`

**test/node/plebbit/**
- [ ] `started-subplebbits.test.ts` → `started-communities.test.ts`

**test/node-and-browser/subplebbit/**
- [ ] `state.subplebbit.test.ts` → `state.community.test.ts`
- [ ] `backward.compatibility.subplebbit.test.ts` → `backward.compatibility.community.test.ts`
- [ ] `updateCid.subplebbit.test.ts` → `updateCid.community.test.ts`
- [ ] `getsubplebbit.plebbit.test.ts` → `getcommunity.pkc.test.ts`
- [ ] `createsubplebbit.plebbit.test.ts` → `createcommunity.pkc.test.ts`
- [ ] `update.subplebbit.test.ts` → `update.community.test.ts`

**test/node-and-browser/subplebbit/ipns/**
- [ ] `ipns.fields.subplebbit.test.ts` → `ipns.fields.community.test.ts`

**test/node-and-browser/signatures/**
- [ ] `subplebbit.test.ts` → `community.test.ts`

**test/node-and-browser/publications/subplebbit-edit/**
- [ ] `subplebbit.edit.publication.test.ts` → `community.edit.publication.test.ts`

### 11.2 Test Content Updates
- [ ] Update all test imports to use new module paths
- [ ] Update all test assertions referencing old names
- [ ] Update fixture references

### 11.3 Test Fixtures (test/fixtures/)
- [ ] `test/fixtures/signatures/subplebbit/` → `test/fixtures/signatures/community/`
- [ ] Update JSON fixture files:
  - `valid_subplebbit_ipfs.json` → `valid_community_ipfs.json`
  - `valid_subplebbit_jsonfied.json` → `valid_community_jsonfied.json`
  - Update content within fixtures to use new property names

### 11.4 Test Configuration
- [ ] `test/run-test-config.js` - Update PLEBBIT_CONFIGS → PKC_CONFIGS
- [ ] Update environment variable references

---

## Phase 12: Documentation

### 12.1 docs/ Directory
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

### 12.2 RPC Documentation
- [ ] `src/rpc/README.md`
- [ ] `src/rpc/EXPORT_SUBPLEBBIT_SPEC.md` → `src/rpc/EXPORT_COMMUNITY_SPEC.md`

---

## Phase 13: GitHub & CI/CD

### 13.1 GitHub Workflows (.github/workflows/)
- [ ] `CI.yml` - Update references
- [ ] `CI-build.yml`
- [ ] `CI-windows-test.yml`
- [ ] `CI-alerts.yml`
- [ ] `CI-plebbit-protocol-test.yml` → Rename if needed
- [ ] `CI-plebbit-react-hooks.yml` → Rename if needed
- [ ] `CI-plebbit-js-benchmarks.yml` → `CI-pkc-js-benchmarks.yml`

### 13.2 Repository Rename (External)
- [ ] GitHub repository: `plebbit/plebbit-js` → Consider new org/repo name
- [ ] Update all workflow URLs

---

## Phase 14: Import Path Updates

After renaming directories and files, update ALL import statements across the codebase:

### 14.1 Core Imports
- [ ] `from "./plebbit/plebbit.js"` → `from "./pkc/pkc.js"`
- [ ] `from "./plebbit/plebbit-with-rpc-client.js"` → `from "./pkc/pkc-with-rpc-client.js"`
- [ ] `from "./plebbit/plebbit-client-manager.js"` → `from "./pkc/pkc-client-manager.js"`
- [ ] `from "./subplebbit/..."` → `from "./community/..."`
- [ ] `from "../plebbit-error.js"` → `from "../pkc-error.js"`

### 14.2 Publication Imports
- [ ] `from "./publications/subplebbit-edit/..."` → `from "./publications/community-edit/..."`

### 14.3 Runtime Imports
- [ ] `from "./runtime/node/subplebbit/..."` → `from "./runtime/node/community/..."`
- [ ] `from "./runtime/browser/subplebbit/..."` → `from "./runtime/browser/community/..."`

---

## Phase 15: Data Migration Code

### 15.1 Storage Path Migration
Document migration requirements for user-facing clients:
- [ ] Document that `subplebbits/` → `communities/` directory rename is needed
- [ ] Document that `.plebbit/` → `.pkc/` directory rename is needed
- [ ] Note: Actual migration code should be implemented in plebbit-cli and desktop apps, NOT in pkc-js
- [ ] Create migration documentation for downstream applications

### 15.2 DNS Record Migration
- [ ] Document process for migrating DNS TXT records
- [ ] Consider adding temporary support for both old and new record names

### 15.3 External Applications Migration (IMPORTANT)
The following applications will need migration code to rename `subplebbits/` → `communities/` directory:
- [ ] **plebbit-cli** - Add directory rename migration on startup
- [ ] **Desktop apps** (electron apps, etc.) - Add directory rename migration
- [ ] Any other apps using plebbit-js data directory structure
- [ ] Document breaking change in release notes for downstream applications

---

## Phase 16: Build & Verification

### 16.1 Build Process
- [ ] Run `npm run build` and fix any compilation errors
- [ ] Verify browser build succeeds
- [ ] Verify Node build succeeds

### 16.2 Test Verification
- [ ] Run full test suite
- [ ] Fix any failing tests
- [ ] Update test expectations where needed

### 16.3 Type Checking
- [ ] Run `npm run typecheck:node`
- [ ] Run `npm run typecheck:browser`
- [ ] Fix any type errors

---

## Execution Order Recommendation

1. **Phase 1:** Package configuration (package.json files)
2. **Phase 2:** Directory structure renaming
3. **Phase 3:** Source file renaming
4. **Phase 14:** Import path updates (do immediately after file renames)
5. **Phase 4:** Class, type & interface renaming
6. **Phase 5:** Schema renaming
7. **Phase 6:** API method & property renaming
8. **Phase 7:** RPC method renaming
9. **Phase 9:** Error messages & logging
10. **Phase 10:** Signer & signature functions
11. **Phase 11:** Test files
12. **Phase 8:** DNS & protocol changes (careful - breaking changes)
13. **Phase 15:** Data migration code
14. **Phase 12:** Documentation
15. **Phase 13:** GitHub & CI/CD
16. **Phase 16:** Build & verification

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

This replaces the previous two-key approach (`subplebbit-address` and `plebbit-author-address`). A single lookup retrieves the community's IPNS key.

**Format:**
- TXT record key: `bitsocial`
- Value (current): `<ipnsB58>` (e.g., `12D3KooWNvSZn...`)
- Value (future): extensible with `;key=value` pairs (e.g., `12D3KooW...;author=12D3KooW...`)

**Benefits:**
- One TXT lookup instead of two
- Simpler client flow
- Extensible format for future needs

---

## Progress Tracking

**How to mark progress:** When an item is completed, change `[ ]` to `[x]`. Example:
- `[ ] Not completed` → `[x] Completed`

Use this section to track overall progress:

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Package Config | [ ] Not Started | |
| Phase 2: Directory Structure | [ ] Not Started | |
| Phase 3: Source Files | [ ] Not Started | |
| Phase 4: Classes & Types | [ ] Not Started | |
| Phase 5: Schemas | [ ] Not Started | |
| Phase 6: API Methods | [ ] Not Started | |
| Phase 7: RPC Methods | [ ] Not Started | |
| Phase 8: DNS & Protocol | [ ] Not Started | Breaking changes |
| Phase 9: Errors & Logging | [ ] Not Started | |
| Phase 10: Signer Functions | [ ] Not Started | |
| Phase 11: Test Files | [ ] Not Started | |
| Phase 12: Documentation | [ ] Not Started | |
| Phase 13: GitHub & CI/CD | [ ] Not Started | |
| Phase 14: Import Paths | [ ] Not Started | |
| Phase 15: Data Migration | [ ] Not Started | |
| Phase 15.3: External Apps | [ ] Not Started | plebbit-cli, desktop apps |
| Phase 16: Build & Verify | [ ] Not Started | |
| Phase 17: Web3 Modularization | [ ] Not Started | Domain resolvers, EVM challenge extraction |

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
| DNS TXT records | Migrate `subplebbit-address` and `plebbit-author-address` → single `bitsocial` record | [ ] Not Started |

---

## Phase 17: Web3 Modularization

Make plebbit-js (pkc-js) a neutral, core library that only handles IPNS/IPFS natively. Name resolution (.bso, ENS-based) and EVM challenges become external plugins in separate GitHub repos. `.sol` support has been removed entirely.

### 17.1 Name Resolver Plugin System

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

### 17.2 External Challenge Registration

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

### 17.3 TODO Items

**Name Resolver System:**
- [ ] Add `nameResolvers` option to `PKCUserOptionsSchema` (array of `{key, resolve, canResolve, provider}`)
- [ ] Add `NameResolverClient` class with `state` and `statechange` event
- [ ] Add `community.clients.nameResolvers` map (key → NameResolverClient)
- [ ] Refactor `src/clients/base-client-manager.ts` resolution flow to use serial `canResolve`/`resolve` algorithm
- [ ] Remove `chainProviders` from `PKCUserOptionsSchema` (breaking change)
- [ ] Add `ERR_NO_RESOLVER_FOR_NAME` error when no resolver can handle a name
- [ ] Remove hardcoded ENS logic from core (resolution moves to external @bitsocial/resolver-bso)
- [ ] Remove all SNS/Solana resolution code (.sol support removed entirely)

**External Challenges:**
- [ ] Remove `evm-contract-call` from `pkcJsChallenges` in `src/runtime/node/subplebbit/challenges/index.ts`
- [ ] Delete `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/evm-contract-call/` directory
- [ ] Export challenge types for external packages

**Dependencies:**
- [ ] Remove web3 dependencies: `viem`, `ethers` from pkc-js (moved to external resolver packages)
- [ ] Remove Solana dependencies: `@bonfida/spl-name-service`, `@solana/web3.js` if present (.sol support removed entirely)

**Downstream Apps:**
- [ ] Update plebbit-cli to install and register name resolvers
- [ ] Update desktop apps to install and register name resolvers

**Release & Distribution:**
- [ ] After rebrand, start publishing `@pkc/pkc-js` to the npm registry
- [ ] Add GitHub CI job(s) to automate npm publishing for `@pkc/pkc-js`

### 17.4 External Repos to Create

| Repository | Purpose | Dependencies |
|------------|---------|--------------|
| @bitsocial/resolver-bso | ENS (.bso) name resolution | viem, ethers |
| @bitsocial/challenge-evm-contract | EVM contract call challenge | viem |

Note: .sol support has been removed. Only ENS-based resolution (.bso) is supported.

### 17.5 Breaking Changes

- No default name resolvers - pkc-js only handles IPNS/IPFS natively
- Users must explicitly provide `nameResolvers` config to resolve `.bso` addresses
- `.sol` support removed entirely - only ENS-based resolution (.bso) is supported
- `evm-contract-call` challenge no longer built-in
- `chainProviders` removed from PlebbitOptions - now configured per-resolver in `nameResolvers` config
- Must register resolvers in `PKC.nameResolvers` static registry before use
- Challenges fall back to resolver URLs, then to their own hardcoded defaults
- DNS TXT records: single `bitsocial` key replaces old `subplebbit-address` and `plebbit-author-address` keys

### 17.6 Challenge System Cleanup

**Default Challenge:**
- [ ] Change default challenge from `publication-match` to `question` (question/answer challenge)
  - File: `src/runtime/node/subplebbit/local-subplebbit.ts` (line ~193, `_defaultSubplebbitChallenges`)

**Remove Built-in Challenges:**
- [ ] Remove `mintpass` challenge from `plebbitJsChallenges`
  - Delete directory: `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/mintpass/`
  - Remove import and entry from: `src/runtime/node/subplebbit/challenges/index.ts`
- [ ] Remove `captcha-canvas-v3` challenge from `plebbitJsChallenges`
  - Delete directory: `src/runtime/node/subplebbit/challenges/plebbit-js-challenges/captcha-canvas-v3/`
  - Remove import and entry from: `src/runtime/node/subplebbit/challenges/index.ts`
  - Remove `canvas` and related dependencies from `package.json`

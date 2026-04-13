# Changelog

## [0.0.15](https://github.com/pkcprotocol/pkc-js/compare/v0.0.14...v0.0.15) (2026-04-12)

### Features

* **schema:** make communityAddress optional in publication creation ([2ad308c](https://github.com/pkcprotocol/pkc-js/commit/2ad308c1ecd843dd05c4b0fb75b83147f745b111))

### Bug Fixes

* **purge:** prevent comment edits from being purged during pre-rebranding DB migration ([f339690](https://github.com/pkcprotocol/pkc-js/commit/f339690e6cdf367f1c1ed635e80711f934f67e1b))
* **rpc:** send communityName/communityPublicKey instead of communityAddress ([8d03773](https://github.com/pkcprotocol/pkc-js/commit/8d03773fd6e7916b03c638c043f3173335698e34))

## [0.0.14](https://github.com/pkcprotocol/pkc-js/compare/v0.0.13...v0.0.14) (2026-04-11)

### Features

* **challenges:** generate unique random default challenge answer per community ([f352de3](https://github.com/pkcprotocol/pkc-js/commit/f352de329643b699cc8b84baa2e99bc1adb4b842))

### Bug Fixes

* **challenges:** preserve default challenge upgrade path when default structure changes ([e0b4f42](https://github.com/pkcprotocol/pkc-js/commit/e0b4f423ab6a2ac656dffe70c1e87f1d8226411d))
* prevent _purgeCommentsWithInvalidSchemaOrSignature from purging all comments ([3984f9f](https://github.com/pkcprotocol/pkc-js/commit/3984f9f2bec365df3e8d168db1837346a299682c))

## [0.0.13](https://github.com/pkcprotocol/pkc-js/compare/v0.0.12...v0.0.13) (2026-04-10)

### Bug Fixes

* rename INTERNAL_SUBPLEBBIT keyv key for pre-rebranding community DBs ([5ee9d35](https://github.com/pkcprotocol/pkc-js/commit/5ee9d35553e974c0070e0eb8d0445c28d61c2ab0))
* skip write operations when opening db in readonly mode ([62b403f](https://github.com/pkcprotocol/pkc-js/commit/62b403f88c00df5b311342303bd6a7b2b8021488))

## [0.0.12](https://github.com/pkcprotocol/pkc-js/compare/v0.0.11...v0.0.12) (2026-04-10)

### Features

* add challenges export subpath ([923171b](https://github.com/pkcprotocol/pkc-js/commit/923171b374ab541bbfe116a3a186c0d9c48564ac))
* add nameResolved to AuthorReservedFields and test subplebbit nameResolved rejection ([f331d33](https://github.com/pkcprotocol/pkc-js/commit/f331d330ded72fa511bfbb5f8464d3736bfe05cd))
* db migration v36→v37 + fix test typing for Phase 1B Step 2 (Phase 1B Step 3) ([4d01aec](https://github.com/pkcprotocol/pkc-js/commit/4d01aecd4ad97974c965666a36ac6f17ce074b79))
* make duplicate publication handling idempotent (up to 3 retries) ([8b5dd67](https://github.com/pkcprotocol/pkc-js/commit/8b5dd6790ee061f78321b5b47bd6a5428a2fa1de))
* make nameResolved a reserved field across all publication types and IPFS records ([1fdbe67](https://github.com/pkcprotocol/pkc-js/commit/1fdbe67eab6edde618ad39d96508b0d864c230a8))
* publication wire format — communityPublicKey/communityName, defer signing (Phase 1B Step 2) ([779b4da](https://github.com/pkcprotocol/pkc-js/commit/779b4da6e7d4854865fa85b82283d606f350e7a8))
* publicKey fallback when community name resolution fails ([e304285](https://github.com/pkcprotocol/pkc-js/commit/e304285d7f41c32139b056b6b7159e007f25350b))
* replace chainProviders-based name resolution with nameResolvers plugin system ([2385cd5](https://github.com/pkcprotocol/pkc-js/commit/2385cd56082dba1e2ac59c347bbfa68b8a601634))
* restructure RPC wire format for local subs and expose raw.localSubplebbit ([086678b](https://github.com/pkcprotocol/pkc-js/commit/086678bd3d66628aa3668fae695f8d940fb219b5))
* **stats:** canonicalize active-user counts across pseudonymity aliases ([e07ee58](https://github.com/pkcprotocol/pkc-js/commit/e07ee58eda262fbae1c1625848ea46ac5ed7f405))
* subplebbit wire format — add `name`, make `address` instance-only (Phase 1B Step 1) ([3c3fac7](https://github.com/pkcprotocol/pkc-js/commit/3c3fac733414d28d1ea94d3ed7bc2bbbb8dae867))
* support key migration over RPC and remove unnecessary itSkipIfRpc ([234c9be](https://github.com/pkcprotocol/pkc-js/commit/234c9beb87a28c945e3e445932e122e512e15703))
* thread stop abort signals into fetch/load operations ([727744b](https://github.com/pkcprotocol/pkc-js/commit/727744b48a55e941233c6e60f04d16b36cda7637))
* update nameResolver resolve to return { publicKey } object and accept abortSignal ([366f5de](https://github.com/pkcprotocol/pkc-js/commit/366f5dedd5136468aa67bb3e6329c3e3ede53701))
* validate subplebbit loading with address/name/publicKey combinations ([4c31894](https://github.com/pkcprotocol/pkc-js/commit/4c3189460da4e65d6a5daf9208a8f3c1adc2124a))

### Bug Fixes

* abort comment and sub verification on stop ([437913e](https://github.com/pkcprotocol/pkc-js/commit/437913e056941188a377b7749bf6142c68a4e46b))
* add "runtimeupdate" RPC event for nameResolved changes without commentUpdate ([02f8a98](https://github.com/pkcprotocol/pkc-js/commit/02f8a98bd3bdcff26462c83fe883e09d485659d5))
* add null guard for raw.subplebbitIpfs in toJSONRpcRemote ([5ea6908](https://github.com/pkcprotocol/pkc-js/commit/5ea69089cce76a1b97aea2af3dd39712d63cdb13))
* align nameResolvers clients test with new nameResolvers system ([2d96ec3](https://github.com/pkcprotocol/pkc-js/commit/2d96ec3af24f407b74c209986d6e6c9b45de5ee4))
* align page signature test with runtime-only author.address ([02ef281](https://github.com/pkcprotocol/pkc-js/commit/02ef2813c785e62ac6df3041067aaec3323bf402))
* align resolver tests with server-side author domain validation ([4e2f635](https://github.com/pkcprotocol/pkc-js/commit/4e2f6359d72e86a2176202cecfec74db3ac10ba8))
* align subplebbit signature test with immutable author.address ([757e750](https://github.com/pkcprotocol/pkc-js/commit/757e750f97ac45a9b9c1e76d9f5ae714e317b5a4))
* align tests and migration with author.address wire format refactor ([d8ec089](https://github.com/pkcprotocol/pkc-js/commit/d8ec0892ccfea57f317e3536ae7a7ffaf5c14889))
* allow author.address in old CommentIpfs records during verification ([55c1363](https://github.com/pkcprotocol/pkc-js/commit/55c13634570a85ee1f5a72f7dda09fe549d24c8a))
* allow authors to delete their own pending/disapproved comments ([45c59cc](https://github.com/pkcprotocol/pkc-js/commit/45c59cc633445eb423f478aea2fec89c87db43b0))
* allow nullable author column in DB tables for empty wire authors ([96172a0](https://github.com/pkcprotocol/pkc-js/commit/96172a0f38e6132fbf95645a8008dab7a7cf3b9e))
* **ci:** allow release-it to run with dirty working dir from build output ([676822a](https://github.com/pkcprotocol/pkc-js/commit/676822a0b9a8245aae65c0f131c9deb9ac6fc40c))
* **ci:** include dist in release-it commit to fix empty changelogs ([8f4ecaa](https://github.com/pkcprotocol/pkc-js/commit/8f4ecaaed4d7d92d1fdf9a25494238f25d565368))
* **ci:** move key-migration test to node-only directory ([7932a96](https://github.com/pkcprotocol/pkc-js/commit/7932a96bf392cbb36ec2031e5f243d02632ad37f))
* **ci:** update benchmarks deploy key secret name to PKC_JS_BENCHMARKS_DEPLOY_KEY ([9c58340](https://github.com/pkcprotocol/pkc-js/commit/9c58340015f1b8b3dd9005f436e1e634de537574))
* correct v36 test schemas to use subplebbitAddress and update stale mock name ([21fc2c2](https://github.com/pkcprotocol/pkc-js/commit/21fc2c26327b5e9255de6c821a9bc7233f431af2))
* deferred signing in test utils + _spreadExtraProps CID mismatch for migrated rows ([21d9b4d](https://github.com/pkcprotocol/pkc-js/commit/21d9b4d2eb04c85fef1d939b4359f365a31adb65))
* deferred signing sets subtype props + robust community address DB queries ([ee716e5](https://github.com/pkcprotocol/pkc-js/commit/ee716e51d60f3d7933e775e52e90a95491cb9c86))
* derive communityName/communityPublicKey from communityAddress ([05b2434](https://github.com/pkcprotocol/pkc-js/commit/05b24342795b25d3902f187d5c52a11296dbcb9d))
* destroy name resolvers when pkc.destroy() is called ([10eca9a](https://github.com/pkcprotocol/pkc-js/commit/10eca9a92f8a44859f9b5f4c459440cb9dfaf087))
* edit({ address: domain }) now sets name for correct address derivation ([d33f4ed](https://github.com/pkcprotocol/pkc-js/commit/d33f4ed004c8417a6759783c8137a13015c00d98))
* fail fast in run-test-config if test server is offline ([6de9c58](https://github.com/pkcprotocol/pkc-js/commit/6de9c58734ba50a942ee534815b05b4c1e3fab86))
* fix multiple RPC test failures ([ad05010](https://github.com/pkcprotocol/pkc-js/commit/ad05010a438f4d86e726622d58cceff4aca5cf43))
* fix RPC test failures for address edit, nameResolved propagation, and spurious updates ([d60e253](https://github.com/pkcprotocol/pkc-js/commit/d60e2532caea63ed15e40692293aa40566a1cc0a))
* fix RPC test failures for nameResolved propagation, internal format key, and test utility ([bb5afca](https://github.com/pkcprotocol/pkc-js/commit/bb5afca307744da1678f34fecebee5c222df5b44))
* fix RPC test failures for subplebbitIpfs, author resolution, nameResolvers ([7f5ae07](https://github.com/pkcprotocol/pkc-js/commit/7f5ae0776e8eff4a1110e589b2f0e9cd8aa41634))
* fix RPC test failures in ownKeys, createSubplebbit, and clone rehydration ([6cf013a](https://github.com/pkcprotocol/pkc-js/commit/6cf013a92cd89893380752194e0d9e8d6b569049))
* gracefully handle invalid subplebbitIpfs schema from old DBs before migration ([f6b0327](https://github.com/pkcprotocol/pkc-js/commit/f6b032700c24eb4275dbec2e7759c989cfe5dbce))
* handle community key migration in comment update handler ([e7b900b](https://github.com/pkcprotocol/pkc-js/commit/e7b900ba012a6641d6200a4098aad79d9c33fe1c))
* handle communityAddress in getCommunityAddressFromRecord and raw.subplebbitIpfs compat ([d6abb44](https://github.com/pkcprotocol/pkc-js/commit/d6abb4417aa62666aa9109a1bde4e0d81ce1c6d4))
* handle getter-only properties in deepMergeRuntimeFields ([c836d8c](https://github.com/pkcprotocol/pkc-js/commit/c836d8c75bf7fbf8334af639ee52b5fa6dbed8b2))
* handle subplebbit name resolution migration ([66c4e79](https://github.com/pkcprotocol/pkc-js/commit/66c4e795bf927d05c27675f9fe9b2714f55d8b07))
* include signature in verifyCommentIpfs cache key to detect tampered signatures ([65eec27](https://github.com/pkcprotocol/pkc-js/commit/65eec27a31dfd9cf1c170f1e6ff89f2a138a2a86))
* insert comment moderation into DB before setting publish trigger ([57be7f6](https://github.com/pkcprotocol/pkc-js/commit/57be7f6d46e018988eb2a316b8c214f5f9853ea1))
* log signatureValidity.reason in community gateway error for better diagnostics ([32fff36](https://github.com/pkcprotocol/pkc-js/commit/32fff36c1b9c6c0b775b5e7a193c528e51ef9c7b))
* **logging:** add error logging before throwing P2P fetch/resolve errors ([76afbdc](https://github.com/pkcprotocol/pkc-js/commit/76afbdc50334aa93459e1f8aaf319cab1293e673))
* make author-name-resolved page tests robust and deterministic ([1415558](https://github.com/pkcprotocol/pkc-js/commit/14155585fc8f00b80cd826a0479e03395083530a))
* make comment author.nameResolved strictly runtime — never copied via spread/stringify ([6914814](https://github.com/pkcprotocol/pkc-js/commit/691481466f53c3fa332f8ccc0373f5bf658b8ca5))
* make modQueue.pages default to {} like posts.pages ([1837289](https://github.com/pkcprotocol/pkc-js/commit/1837289a15c9aa62b3e97e5d616e98c7404b9b58))
* **merge:** fix merge algo and add a regression for it ([c46c35c](https://github.com/pkcprotocol/pkc-js/commit/c46c35cea047431c1f3104954a9481174ef8750f))
* normalize domain author input ([98e1879](https://github.com/pkcprotocol/pkc-js/commit/98e1879185866c207520b42bab644fe4b6e01367))
* pass object param to unsubscribe in PlebbitWsServer.destroy() ([77d15d8](https://github.com/pkcprotocol/pkc-js/commit/77d15d87d9e5d8775483cc02126c2240fc52d08d))
* preserve author.nameResolved through createComment ([468da8b](https://github.com/pkcprotocol/pkc-js/commit/468da8b855f756bc29211deadeeee758c034d3a3))
* preserve commentUpdate.author fields (subplebbit, etc.) in page mapping ([ab1c4fb](https://github.com/pkcprotocol/pkc-js/commit/ab1c4fb12868e9e08816d4e56c68f4b499754130))
* preserve original key order in RPC comment parsers to fix CID mismatch ([9e3c0d9](https://github.com/pkcprotocol/pkc-js/commit/9e3c0d9310feb3ffbf0897a0d57c451bca607a50))
* preserve subplebbit page runtime fields on rehydrate ([c6687a3](https://github.com/pkcprotocol/pkc-js/commit/c6687a320891dc1809e28989cac36b10df05e121))
* prevent 60s hang in LocalSubplebbit.stop() when stopping update loop ([e23e9d0](https://github.com/pkcprotocol/pkc-js/commit/e23e9d06fa1aee4a35950f837251ec187fd44395))
* prevent nameResolver state pollution from reply/page author resolution ([2e73564](https://github.com/pkcprotocol/pkc-js/commit/2e735641534604a2b254956009455bd901e15472))
* prevent redundant IPNS resolution in subplebbit update loop ([3974e4b](https://github.com/pkcprotocol/pkc-js/commit/3974e4be2ff68331bab7a3f071d032d8b2c209f5))
* prevent subplebbit state changes from polluting comment updatingState during update fetch ([6ae996e](https://github.com/pkcprotocol/pkc-js/commit/6ae996ef4952669f122d6ca2bbf00ee13e4dd9f6))
* propagate nameResolved from updating instance to mirroring comment ([4600552](https://github.com/pkcprotocol/pkc-js/commit/4600552a93389160d56a62b00a453384ea49effd))
* propagate RPC runtimeFields through mirroring for page-level nameResolved ([d2a8853](https://github.com/pkcprotocol/pkc-js/commit/d2a885319c9ef48c629c722cdc1c61f7abd03d7e))
* rebuild runtime author in setExtraPropOnCommentModerationAndSign ([3bf00d5](https://github.com/pkcprotocol/pkc-js/commit/3bf00d522aaf7f1efa41f43166d0ede138944530))
* rebuild runtime author in setExtraPropOnVoteAndSign and setExtraPropOnCommentEditAndSign ([0def082](https://github.com/pkcprotocol/pkc-js/commit/0def0828fca150fe759f77bb396c350f2f106afb))
* reduce idempotent duplicate publishing from 3 retries to 1 ([daf3367](https://github.com/pkcprotocol/pkc-js/commit/daf3367028020fb3159148359d2491c7c66e4b4f))
* reject deprecated subplebbitAddress and communityAddress with distinct errors ([421efd7](https://github.com/pkcprotocol/pkc-js/commit/421efd7969ca26f751583d825b036accd644c527))
* remove author.address from pre-signed comment test to match wire format refactor ([614a70e](https://github.com/pkcprotocol/pkc-js/commit/614a70e29599021d8c6da852317f685992658fc6))
* remove duplicate error emission in postResolveNameResolverSuccess to fix test timeout ([4373cd4](https://github.com/pkcprotocol/pkc-js/commit/4373cd48cf84f81b2836208d0e9aaa8dfef02905))
* repair 8 test regressions from wire format rename and duplicate retry reduction ([ed73574](https://github.com/pkcprotocol/pkc-js/commit/ed7357446ccace55ce73d64eeca4a33bae2d5982))
* repair test regressions from wire format rename and deferred signing ([5dc9f70](https://github.com/pkcprotocol/pkc-js/commit/5dc9f70756239d91d435075ef0ca41d47929140a))
* resolve 12 test regressions from registry refactor and deferred signing ([391d151](https://github.com/pkcprotocol/pkc-js/commit/391d15123a4ef1df7520f5e336f9f326d58cfe65))
* resolve npm audit vulnerabilities (28 → 5) ([2babb6d](https://github.com/pkcprotocol/pkc-js/commit/2babb6dd844b02cb1c8a7ddfb806d35d9f97c2c8))
* resolve remaining test regressions from wire format rename and deferred signing ([491c9f2](https://github.com/pkcprotocol/pkc-js/commit/491c9f2c2552667630e734081577cb2673353d5b))
* resolve tsc errors after package upgrades ([9fc053c](https://github.com/pkcprotocol/pkc-js/commit/9fc053ccfa8ed6a7f640024a6af058def3e6be74))
* run _validateSignature after deferred signing in publish() ([ed29425](https://github.com/pkcprotocol/pkc-js/commit/ed2942517e15c17b41c25e058f4e518fb96ee97b))
* set nameResolved to false when no resolver exists for the author's TLD ([cd41cda](https://github.com/pkcprotocol/pkc-js/commit/cd41cdab3c0f2de33ac9248cf4165ab4501503f6))
* skip already-purged CIDs during migration, fix invalid ENS author test ([b364004](https://github.com/pkcprotocol/pkc-js/commit/b364004759045b3add941510ba83b34b80a53be9))
* strip runtime author fields from CommentIpfs before IPFS storage ([d1baa0a](https://github.com/pkcprotocol/pkc-js/commit/d1baa0a9a769e901edc673e387f1fca9ba9dc165))
* strip runtime-only author fields before DB insertion ([a2914a8](https://github.com/pkcprotocol/pkc-js/commit/a2914a8f1fb4b126d7dec31eb3b6b15b42d4a88b))
* strip runtimeFieldsFromRpc in test util to fix RPC subplebbit comparison ([cda1bb2](https://github.com/pkcprotocol/pkc-js/commit/cda1bb20617b0924346b86bba84dc6e3a22888c2))
* subplebbit rejects publications with unsupported author TLDs ([7515a7f](https://github.com/pkcprotocol/pkc-js/commit/7515a7f2d39919a815f0cc70191fd5ee9453b9fa))
* **subplebbit:** dedupe anonymized comments by original signature ([5826bf9](https://github.com/pkcprotocol/pkc-js/commit/5826bf938ab2302e289cd2ff6644cdf6a71e711b))
* **subplebbit:** guard against undefined settings in _purgeDisapprovedCommentsOlderThan ([3a2a1f0](https://github.com/pkcprotocol/pkc-js/commit/3a2a1f09775c68d7de3fa7472fb47f2589353314))
* support getSubplebbit public key fallback ([c0610f1](https://github.com/pkcprotocol/pkc-js/commit/c0610f15fda06fc67dac934e23280cddc7846ef7))
* sync background subplebbit name resolver state ([99b2f07](https://github.com/pkcprotocol/pkc-js/commit/99b2f07c8758b31d7348930768e87f841cd4254d))
* sync name in setAddress, revert field stripping in createComment, fix test fallback ([67ee099](https://github.com/pkcprotocol/pkc-js/commit/67ee09941a905912ec4662ed3c66224cf6eefc21))
* **test:** poll for MFS cleanup in purged postUpdates test to avoid race condition ([fd79e79](https://github.com/pkcprotocol/pkc-js/commit/fd79e7976b5a9ad729a928586809b1d4211ca87d))
* **test:** reduce parallel publish stress count for browser to prevent Firefox CI timeout ([7f109ca](https://github.com/pkcprotocol/pkc-js/commit/7f109cafe0bd200acd2c46b8a025bf527f528424))
* **test:** replace exec with spawn for Kubo processes to prevent maxBuffer crashes ([e89f470](https://github.com/pkcprotocol/pkc-js/commit/e89f47051a73391c4c6812a8a5afb1c4aa39d0db))
* **test:** replace getSubplebbit with createSubplebbit+update in createsubplebbit tests ([329043b](https://github.com/pkcprotocol/pkc-js/commit/329043b8bc05f5b413e88ef6894c8354bbda80a5))
* **test:** replace getSubplebbit() with createSubplebbit() + update() for CI resilience ([cfa7917](https://github.com/pkcprotocol/pkc-js/commit/cfa79179ae99fe5ec583fdd050ce309199406d94))
* **test:** update CommentModeration unsupported TLD test to match edit-time validation ([be662e1](https://github.com/pkcprotocol/pkc-js/commit/be662e12a74964afd650bc5c012590ec550062df))
* update stale method names in test server and lockfile import ([2576b7d](https://github.com/pkcprotocol/pkc-js/commit/2576b7d098c1cfe1162bbeaf6d15395ac68c7299))
* update subplebbit fixture to include runtime author fields (publicKey, name) ([cbcd72b](https://github.com/pkcprotocol/pkc-js/commit/cbcd72b8f34d9456ee4b1ecc0b303d56dbd02962))
* use @plebbit/proper-lockfile fork in update subplebbit test ([11e664e](https://github.com/pkcprotocol/pkc-js/commit/11e664ed60c43e489224837c9c53a871a50d1acf))
* use delete instead of undefined assignment for author in anonymization ([30502f7](https://github.com/pkcprotocol/pkc-js/commit/30502f7b02c89845bdc33f123d54de0cdb079c31))
* use derived peer ID for _community.publicKey in createStaticSubplebbitRecordForComment ([0d4b1ea](https://github.com/pkcprotocol/pkc-js/commit/0d4b1ea8cf1cbe67cd10def6b590524b8a4a162a))
* use setTimeout for inflight fetch cleanup and set USE_RPC in test runner ([95cf74a](https://github.com/pkcprotocol/pkc-js/commit/95cf74a1978e0a9b8276fef03b7e8b88905b7668))
* use signers[3] in nameResolvers test to match mock resolver for plebbit.bso ([d6cfde1](https://github.com/pkcprotocol/pkc-js/commit/d6cfde135685ae98225c1511cb23caf7c5b2b412))
* use static SubplebbitSignedPropertyNames for subplebbitIpfs field picking ([ba6b251](https://github.com/pkcprotocol/pkc-js/commit/ba6b251c2f2a1730eb0a5c0a87ae5a656919b4f0))
* validate role address domains can be resolved during subplebbit.edit() ([ec0d62d](https://github.com/pkcprotocol/pkc-js/commit/ec0d62d62de331b9f4e535ed877c0fb1b4e230d6))

### Build

* **deps:** upgrade deps ([1163aa6](https://github.com/pkcprotocol/pkc-js/commit/1163aa6cabfe501a2fec25f859ffc56b97ff44f8))
* **deps:** upgrade kubo ([a8b3a6f](https://github.com/pkcprotocol/pkc-js/commit/a8b3a6faa974aa5df0faeacf1532ca9c371eb9ef))
* **deps:** upgrade packages ([6bb863d](https://github.com/pkcprotocol/pkc-js/commit/6bb863d220611292b45295bc88932876389f2b1c))

## 0.0.11 (2026-02-25)

## 0.0.10 (2026-02-25)

### Build

* update dist ([6eaf4b5](https://github.com/plebbit/plebbit-js/commit/6eaf4b52e1f0ce5d0de4fc11032b66d7165f04f2))

## 0.0.9 (2026-02-23)

### Build

* update dist ([ad2e863](https://github.com/plebbit/plebbit-js/commit/ad2e86394240fd673aba3144aae10126e8e10043))

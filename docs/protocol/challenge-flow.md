# Challenge/Response Flow

## Summary

Before a publication is accepted by a community, the author must complete a challenge exchange. This is a 4-message encrypted conversation over pubsub between the author and the community. The community defines which challenges to use in its `challenges[]` configuration.

## The 4-Message Exchange

```
Author                              Community
  │                                     │
  │─── ChallengeRequestMessage ────────>│  Encrypted with community's public key
  │    (contains the publication)       │  Contains: comment/vote/edit + challengeRequest options
  │                                     │
  │<── ChallengeMessage ───────────────│  Encrypted reply
  │    (contains challenges to solve)   │  Contains: challenges {index: challenge} (text, type, caseInsensitive)
  │                                     │
  │─── ChallengeAnswerMessage ────────>│  Author's answers
  │    (contains answers)               │  Contains: challengeAnswers {index: answer}
  │                                     │
  │<── ChallengeVerificationMessage ───│  Success or failure
  │    (result + optional comment data) │  Contains: challengeSuccess, comment, commentUpdate
  │                                     │
```

## One Exchange Per Publication Instance

A publication instance runs this exchange once. It is spent once `publish()` gets past pre-flight (the community fetch, signing, the signature hook), which is the point from which a request can leave the instance, or once `stop()` ends a `publish()` that was called. From then on a second `publish()` rejects with `ERR_PUBLICATION_PUBLISH_ALREADY_CALLED` (its `details` carry `state`, `publishingState`, `receivedChallenge` and `receivedChallengeVerification`), whatever came of the exchange. A `publish()` call made while another one is still running on the same instance rejects too.

A `publish()` that rejected during pre-flight does not spend the instance: no exchange exists, so there is nothing for a second one to cross with, and the same instance can call `publish()` again.

To publish again once it is spent, create a new instance, and `stop()` the old one if it is still publishing:

-   A new publication (new timestamp, new signature): call `createComment` / `createVote` / ... with the options again. This is what a client does after a wrong challenge answer.
-   The same signed publication: pass the signed message of the first instance, `pkc.createComment(comment.raw.pubsubMessageToPublish)`. A community that already stored it answers idempotently, see "Duplicate and Overlapping Requests" below.

A second exchange on the same instance used to cross with the first one's requests, no-response watchdog, verdict and teardown, which is why the rule is one exchange per instance rather than one exchange at a time.

The publish ends once, by whichever of these is recorded first: the community's verification, a failure (no response, every pubsub provider threw, a verification that cannot be decrypted, a request a local community or the RPC server rejected) or `stop()`. Anything that arrives after that changes nothing. For example a verification that lands while a no-response failure is being torn down is dropped, and `stop()` after a verification leaves `publishingState` at `succeeded` or `failed`.

A `CHALLENGE` or `CHALLENGEVERIFICATION` whose signature is not the community's is logged and dropped: no `error` event and no state change. Anyone on the topic can read a `challengeRequestId` and send a message for it, so such a message says nothing about the publication.

`publishChallengeAnswers` after the exchange ended rejects with `ERR_PUBLICATION_CHALLENGE_EXCHANGE_ENDED`. Over RPC the exchange runs on the server, and the client rejects with `ERR_RPC_CLIENT_NO_ACTIVE_PUBLISH_SUBSCRIPTION` once its publish subscription is gone.

A success verification the client cannot use ends the publication as `failed` with the error emitted: an encrypted part that cannot be decrypted or parsed, or a returned comment that differs from the one published or does not verify.

## Message Schemas

All in `src/pubsub-messages/schema.ts`:

| Message                        | Schema                               | Encrypted Payload                                                                       |
| ------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------- |
| `ChallengeRequestMessage`      | `ChallengeRequestMessageSchema`      | `DecryptedChallengeRequestSchema`: contains the publication + challenge options         |
| `ChallengeMessage`             | `ChallengeMessageSchema`             | `DecryptedChallengeSchema`: contains `challenges`, a record keyed by challenge index, to solve |
| `ChallengeAnswerMessage`       | `ChallengeAnswerMessageSchema`       | `DecryptedChallengeAnswerSchema`: contains `challengeAnswers`, a record keyed by challenge index |
| `ChallengeVerificationMessage` | `ChallengeVerificationMessageSchema` | `DecryptedChallengeVerificationSchema`: contains `comment` + `commentUpdate` on success |

## Encryption

-   Uses **AES-GCM** with a shared secret derived from Ed25519 key exchange
-   `ChallengeRequestMessage.encrypted`: encrypted with community's `encryption.publicKey`
-   Each request uses a **new keypair**, `challengeRequestId` = multihash of the request's `signature.publicKey`
-   See `docs/encryption.md` for low-level details

## Challenge Types

Built-in challenges defined in `src/runtime/node/community/challenges/`:

| Type                | Description                                 |
| ------------------- | ------------------------------------------- |
| `text-math`         | Math problems (e.g., "2+3=?")               |
| `question`          | Q&A challenges                              |
| `publication-match` | Reject if publication doesn't match pattern |
| `blacklist`         | Reject based on lists                       |
| `whitelist`         | Allow only from lists                       |
| `fail`              | Always fails (for testing)                  |

External challenges can be registered via `PKC.challenges` static object.

## Exclude Rules

Each challenge in `CommunityIpfsType.challenges[]` can have `exclude` rules that skip the challenge for certain authors:

-   Author karma thresholds (postScore, replyScore)
-   Account age
-   Author identity: `publicKeys` (key-derived addresses, the runtime `author.publicKey`) or `names` (domains). All exclude array fields are plural; `address` and `role` were the pre-v42 names
-   Author role (`roles`: admin, moderator)
-   Whether previous challenges in the array were already passed
-   Rate limiting

Exclude logic: `src/runtime/node/community/challenges/exclude/exclude.ts`

### Author identity in excludes, roles and address lists

`author.address` at runtime is `name || signerAddress`, built from the unresolved wire `author.name`. It is publisher-controlled and never used to decide identity on the community side. Every matcher goes through `createAuthorIdentityMatcher` (`src/runtime/node/community/local-community/author-identity.ts`):

| Configured identity                                                                            | Matches when                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| key-derived address (`exclude.publicKeys`, a raw `roles` key, a raw blacklist/whitelist entry) | it equals the address derived from `signature.publicKey`                                                                                                                                                                                                                                                                                                                                                          |
| domain (`exclude.names`, a domain `roles` key, a domain blacklist/whitelist entry)             | it is the same name as the wire `author.name` (`areEquivalentNames`: `.eth`/`.bso` aliases and letter case are equivalent, issue #424) **and** the wire name resolves to the signer address. Resolution happens at match time with `cache: { maxAge: 0 }`, regardless of `pkc.resolveAuthorNames`. A resolver failure is still a non-match and never throws out of the matcher, but it is now reported: see below |

The matcher returns an outcome, not a boolean. A non-match caused by a domain the community could not verify carries a `nameFailure` naming the reason; a domain that resolved fine and points at somebody else carries nothing, because that is an impostor rather than a misconfiguration and is owed no explanation. The four reasons come from `docs/protocol/names-and-addresses.md` and each asks the publisher for something different:

| What happened                                    | Reason                                              |
| ------------------------------------------------ | --------------------------------------------------- |
| the resolvers answered, the name has no record   | `ERR_AUTHOR_NAME_HAS_NO_RECORD`                     |
| every resolver errored, or the resolve timed out | `ERR_COMMUNITY_FAILED_TO_RESOLVE_AUTHOR_NAME`       |
| no resolver here handles that TLD                | `ERR_COMMUNITY_HAS_NO_RESOLVER_FOR_AUTHOR_NAME_TLD` |
| the record exists and is not a valid key         | `ERR_AUTHOR_NAME_RECORD_IS_NOT_A_VALID_KEY`         |

Surfacing is **decisive-only**. The reason reaches the publisher as `challengeVerification.reason` only when the publication is rejected _and_ the failed match is what would have excused or authorized it, and it takes precedence over a challenge's own `aggregatedReason` (the challenge text describes the symptom, this describes the cause). In `exclude.ts` that is enforced structurally: the cheap predicates run first and a domain identity is consulted last, so an exclude item that was already doomed never pays for the resolve and never attributes a failure to it. The failure is captured before the challenge answer round-trip, so it survives a challenge the author goes on to fail. The per-resolver errors stay node-side, in the `PKCError`'s `details`; the wire verification carries only the reason string. See issue #353.

Surfacing is decisive **per challenge**. An exclude only ever excuses the challenge it is attached to, so the reason is published only when every challenge that actually failed is one whose own exclude would have excused this author had the name verified. Fail one unrelated challenge as well and the resolver error explains nothing, so the challenge's own text is what they get. The failures are therefore recorded per index, and an index that `shouldExcludeChallengeCommentCids` excludes anyway records nothing at all, since a challenge that was not required cannot explain a rejection.

One matcher is built per challenge phase (`ParsedChallengeRequest.authorIdentityMatcher`) and threaded through validation, the excludes, the challenges and storage, so a publication's domain is resolved at most once per phase instead of once per call site. An exchange that needs no challenge has a single phase and therefore a single resolve; one that goes out to the author and comes back has two, for the reason in the next paragraph. A key-derived entry is compared before any domain is resolved, so a moderator listed under both their public key and their domain matches for free and stays authorized while the resolver is down. See issue #354.

**The matcher is rebuilt at the challenge answer round-trip.** An interactive challenge can leave the author thinking for up to `CHALLENGE_EXCHANGE_TTL_MS`, and the identity verdict was memoised before the challenge went out. So `getChallengeVerification` builds a second matcher the moment the answers arrive and hands it to everything downstream: the deferred and cycle-broken `getChallenge` calls, and the storage step that decides whether a mod is exempt from pseudonymity. A TXT record repointed while the author was solving a captcha must not still read as theirs. Nothing before the round-trip is rebuilt, because no wall-clock time passes there, and an exchange that needed no challenge at all keeps the single resolve. `community.roles` is re-read on every call, so a revoked role is never stale in either phase; only the name-to-key binding is memoised.

The `blacklist` challenge is the deliberate exception: an unverifiable blacklisted domain stays a non-match, so it fails open. Tracked separately in issue #356.

There is no `exclude.address`, and `exclude.role` is now `exclude.roles`. The private settings schema (`CommunityChallengeSettingSchema`) rejects both old fields, so a stale owner config fails loudly instead of silently becoming an exclude that matches nobody. The public record schema (`CommunityChallengeSchema`) stays loose: a client on this version still loads records published by communities that have not upgraded, where the old fields pass through unused. Private settings written before DB version 42 are migrated by `DbHandler._migrateOldSettings`, which splits the old `address` array by kind into `publicKeys` and `names` and renames `role` to `roles`. See issue #267.

## Challenge Indexes

Every per-challenge payload is a record keyed by the **challenge index**: the position of the challenge in `community.challenges` (`settings.challenges` on the owner side), as a decimal string. `challengeErrors` in `CHALLENGEVERIFICATION` already worked this way, and these now match it (issue #567):

| Message | Field | Holds |
| ------- | ----- | ----- |
| `CHALLENGEREQUEST` | `challengeAnswers` (optional) | Pre-answers. A challenge with no key has no pre-answer and behaves as if none were sent. Never empty when present. |
| `CHALLENGE` | `challenges` | Only the challenges that still need an answer, so the keys are a sparse subset. Never empty: a community with nothing to ask sends no `CHALLENGE`. |
| `CHALLENGEANSWER` | `challengeAnswers` | One answer per key of the `CHALLENGE` it answers. Never empty. |
| `CHALLENGEVERIFICATION` | `challengeErrors` | The error of each failed challenge. |

Why not arrays: a positional array cannot say "no answer for this one". A client that pre-answered only challenge 2 had to put filler in slots 0 and 1, and a `question` challenge at index 0 then read the filler as a wrong answer. A key per challenge removes that, and the answer no longer depends on which challenges happened to be excluded or pre-answered.

-   The community hands each challenge its own pre-answer as `challengeAnswer` in `getChallenge`, so a challenge does not index `challengeAnswers` itself.
-   Keys the community does not recognise are ignored. A pending challenge with no key in the `CHALLENGEANSWER` fails with `"No answer."`.
-   The array form is rejected at the schema, with no compatibility path.
-   The index is only as stable as the array order: reordering `settings.challenges` re-targets `exclude.challenges` and any pre-answer already in flight, so owners should not reorder challenges of a community that publishers are actively answering.

## ChallengeVerification Result

On **success**:

-   `challengeSuccess: true`
-   Encrypted payload contains `{ comment: CommentIpfs, commentUpdate: CommentUpdateForChallengeVerification }`
-   The `commentUpdate` includes the assigned `cid`, `number`, `postNumber`

On **failure**:

-   `challengeSuccess: false`
-   `challengeErrors`: `{ [challengeIndex]: errorMessage }`
-   `reason`: human-readable failure reason

Three reasons exist so that a publication the community could not republish byte-for-byte is refused instead of stored (issue #387): `ERR_PUBLICATION_AUTHOR_IS_AN_EMPTY_OBJECT` and `ERR_PUBLICATION_HAS_MALFORMED_UNICODE_STRING` from validation (`checkPublicationValidity`), and `ERR_COMMUNITY_CANNOT_STORE_PUBLICATION_VERBATIM` from the store-time gate, which rebuilds the comment or author edit from a read-back of its row (inserted in a savepoint that is rolled back, issue #417) and refuses to store it if the rebuilt record no longer hashes to its cid or verifies. See `docs/protocol/signing.md`.

## A Throwing Handler Ends One Publication, Not The Process

A publication is driven by entry points nothing awaits: the pubsub handler (`_handleChallengeExchange`), the RPC subscription handlers (`_handleIncoming*FromRpc`), the listeners put on a local community, and the no-response watchdog. A throw in one is an unhandled rejection, which ends a Node process. `Publication._guardDetachedHandler` wraps each of them. When one throws it logs, runs the teardown (itself guarded) and reports `ERR_PUBLICATION_INTERNAL_ERROR` with the entry point and the original as `cause`:

- before the verdict: the publication ends in `publishingState: "failed"` and `error` is emitted through the usual state-change path;
- after the verdict: the outcome stands, `error` is emitted and nothing else changes.

The reporting never throws, even when nothing listens to `error`. A new async listener, timer or fire-and-forget call in `publication.ts` must go through the wrapper: `test/node/publications/publication-detached-handler-guard.test.ts` reads the source and fails when one does not.

## Duplicate and Overlapping Requests

A challenge request carries a signed publication, and the signature is the identity of that publication. A publisher may send the same signed publication more than once: after a lost verification, or as an automatic retry to another pubsub provider when no response arrives within its provider-switch threshold (the retry uses a new `challengeRequestId`). The community answers by signature, in `src/runtime/node/community/local-community/challenges.ts`:

-   **Already stored**: the request is a replay. The community answers `challengeSuccess: true` with the stored record and its `cid` (an _idempotent_ verification) once per signature within a 10-minute window (`_duplicatePublicationAttempts`), and rejects further replays with `ERR_DUPLICATE_COMMENT` / `ERR_DUPLICATE_COMMENT_EDIT` / `ERR_DUPLICATE_COMMENT_MODERATION`. Nothing new is stored either way.
-   **Exchange in flight**: a request for a signed publication whose challenge exchange is still running (`_inFlightPublicationExchanges`) waits for that exchange to settle instead of running the challenge again, and only then validates against the database. If the first exchange stored the publication, the waiter gets the idempotent verification. If the first exchange failed, the waiter runs its own exchange as a fresh attempt. Neither outcome consumes the replay allowance above, because the waiter was never a replay of a stored row. The lock is taken before validation, not after, so the duplicate check can never observe a row the overlapping exchange stored mid-validation and misclassify the request as a replay.
-   **Stored between validation and storage**: if a duplicate is still detected when storing (the last-resort check), the community answers idempotently as well rather than failing an accepted publication.

The idempotent verification rebuilds the record with `deriveCommentIpfsFromCommentTableRow` so it hashes to the stored `cid`; a post record must not carry `postCid`, and `extraProps` must be restored, or the author rejects the payload and never learns its `cid`. If the stored row is pending approval, the verification's `commentUpdate.pendingApproval` is `true`, exactly as in the verification of the exchange that stored it.

Every wait in this flow is bounded by one value, `CHALLENGE_EXCHANGE_TTL_MS` (10 minutes, `src/runtime/node/community/local-community/defaults.ts`): it is the ttl of the per-exchange caches (ongoing exchanges, answer promises, the replay allowance), the bound on waiting for an author's challenge answer, and the backstop on waiting for an in-flight exchange. An exchange whose author never answers fails with `ERR_COMMUNITY_TIMED_OUT_WAITING_FOR_CHALLENGE_ANSWER` when the ttl passes, which releases the signature so a request waiting on it runs its own exchange.

## Community Challenge Configuration

The community owner configures challenges privately via `community.settings.challenges[]`. Only sanitized metadata is published publicly to `community.challenges[]`, the `options` field (containing answers, passwords, address lists) is always stripped. See [challenge-settings.md](challenge-settings.md) for the full private/public boundary.

## Key Files

| File                                                       | Purpose                                |
| ---------------------------------------------------------- | -------------------------------------- |
| `src/pubsub-messages/schema.ts`                            | All message schemas                    |
| `src/pubsub-messages/types.ts`                             | Message type definitions               |
| `src/runtime/node/community/challenges/index.ts`           | Challenge processing logic (Node-only) |
| `src/runtime/node/community/challenges/exclude/exclude.ts` | Exclude rule evaluation                |
| `src/publications/publication.ts`                          | Author-side publish flow               |

## Common Mistakes

-   Forgetting that challenge messages are encrypted, you can't read them without the shared secret.
-   Confusing `CommunityIpfsType.challenges[]` (configuration) with `ChallengeMessage.challenges[]` (actual challenges to solve).
-   Not handling `pendingApproval`, even on challenge success, the comment may go to mod queue.

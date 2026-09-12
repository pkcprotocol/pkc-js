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
  │    (contains challenges to solve)   │  Contains: challenges[] (text, type, caseInsensitive)
  │                                     │
  │─── ChallengeAnswerMessage ────────>│  Author's answers
  │    (contains answers)               │  Contains: challengeAnswers[]
  │                                     │
  │<── ChallengeVerificationMessage ───│  Success or failure
  │    (result + optional comment data) │  Contains: challengeSuccess, comment, commentUpdate
  │                                     │
```

## Message Schemas

All in `src/pubsub-messages/schema.ts`:

| Message                        | Schema                               | Encrypted Payload                                                                       |
| ------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------- |
| `ChallengeRequestMessage`      | `ChallengeRequestMessageSchema`      | `DecryptedChallengeRequestSchema`: contains the publication + challenge options         |
| `ChallengeMessage`             | `ChallengeMessageSchema`             | `DecryptedChallengeSchema`: contains `challenges[]` to solve                            |
| `ChallengeAnswerMessage`       | `ChallengeAnswerMessageSchema`       | `DecryptedChallengeAnswerSchema`: contains `challengeAnswers[]`                         |
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

| Configured identity                                                                            | Matches when                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| key-derived address (`exclude.publicKeys`, a raw `roles` key, a raw blacklist/whitelist entry) | it equals the address derived from `signature.publicKey`                                                                                                                                                                                                                                      |
| domain (`exclude.names`, a domain `roles` key, a domain blacklist/whitelist entry)             | it equals the wire `author.name` **and** resolves to the signer address. Resolution happens at match time with `cache: { maxAge: 0 }`, regardless of `pkc.resolveAuthorNames`. A resolver failure is still a non-match and never throws out of the matcher, but it is now reported: see below |

The matcher returns an outcome, not a boolean. A non-match caused by a domain the community could not verify carries a `nameFailure` naming the reason; a domain that resolved fine and points at somebody else carries nothing, because that is an impostor rather than a misconfiguration and is owed no explanation. The four reasons come from `docs/protocol/names-and-addresses.md` and each asks the publisher for something different:

| What happened                                    | Reason                                              |
| ------------------------------------------------ | --------------------------------------------------- |
| the resolvers answered, the name has no record   | `ERR_AUTHOR_NAME_HAS_NO_RECORD`                     |
| every resolver errored, or the resolve timed out | `ERR_COMMUNITY_FAILED_TO_RESOLVE_AUTHOR_NAME`       |
| no resolver here handles that TLD                | `ERR_COMMUNITY_HAS_NO_RESOLVER_FOR_AUTHOR_NAME_TLD` |
| the record exists and is not a valid key         | `ERR_AUTHOR_NAME_RECORD_IS_NOT_A_VALID_KEY`         |

Surfacing is **decisive-only**. The reason reaches the publisher as `challengeVerification.reason` only when the publication is rejected _and_ the failed match is what would have excused or authorized it, and it takes precedence over a challenge's own `aggregatedReason` (the challenge text describes the symptom, this describes the cause). In `exclude.ts` that is enforced structurally: the cheap predicates run first and a domain identity is consulted last, so an exclude item that was already doomed never pays for the resolve and never attributes a failure to it. The failure is captured before the challenge answer round-trip, so it survives a challenge the author goes on to fail. The per-resolver errors stay node-side, in the `PKCError`'s `details`; the wire verification carries only the reason string. See issue #353.

Surfacing is decisive **per challenge**. An exclude only ever excuses the challenge it is attached to, so the reason is published only when every challenge that actually failed is one whose own exclude would have excused this author had the name verified. Fail one unrelated challenge as well and the resolver error explains nothing, so the challenge's own text is what they get. The failures are therefore recorded per index, and an index that `excludeChallengeCommentCids` excludes anyway records nothing at all, since a challenge that was not required cannot explain a rejection.

One matcher is built per challenge phase (`ParsedChallengeRequest.authorIdentityMatcher`) and threaded through validation, the excludes, the challenges and storage, so a publication's domain is resolved at most once per phase instead of once per call site. An exchange that needs no challenge has a single phase and therefore a single resolve; one that goes out to the author and comes back has two, for the reason in the next paragraph. A key-derived entry is compared before any domain is resolved, so a moderator listed under both their public key and their domain matches for free and stays authorized while the resolver is down. See issue #354.

**The matcher is rebuilt at the challenge answer round-trip.** An interactive challenge can leave the author thinking for up to `CHALLENGE_EXCHANGE_TTL_MS`, and the identity verdict was memoised before the challenge went out. So `getChallengeVerification` builds a second matcher the moment the answers arrive and hands it to everything downstream: the deferred and cycle-broken `getChallenge` calls, and the storage step that decides whether a mod is exempt from pseudonymity. A TXT record repointed while the author was solving a captcha must not still read as theirs. Nothing before the round-trip is rebuilt, because no wall-clock time passes there, and an exchange that needed no challenge at all keeps the single resolve. `community.roles` is re-read on every call, so a revoked role is never stale in either phase; only the name-to-key binding is memoised.

The `blacklist` challenge is the deliberate exception: an unverifiable blacklisted domain stays a non-match, so it fails open. Tracked separately in issue #356.

There is no `exclude.address`, and `exclude.role` is now `exclude.roles`. The private settings schema (`CommunityChallengeSettingSchema`) rejects both old fields, so a stale owner config fails loudly instead of silently becoming an exclude that matches nobody. The public record schema (`CommunityChallengeSchema`) stays loose: a client on this version still loads records published by communities that have not upgraded, where the old fields pass through unused. Private settings written before DB version 42 are migrated by `DbHandler._migrateOldSettings`, which splits the old `address` array by kind into `publicKeys` and `names` and renames `role` to `roles`. See issue #267.

## ChallengeVerification Result

On **success**:

-   `challengeSuccess: true`
-   Encrypted payload contains `{ comment: CommentIpfs, commentUpdate: CommentUpdateForChallengeVerification }`
-   The `commentUpdate` includes the assigned `cid`, `number`, `postNumber`

On **failure**:

-   `challengeSuccess: false`
-   `challengeErrors`: `{ [challengeIndex]: errorMessage }`
-   `reason`: human-readable failure reason

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

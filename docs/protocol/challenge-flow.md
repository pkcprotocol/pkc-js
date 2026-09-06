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

| Configured identity                                                                            | Matches when                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| key-derived address (`exclude.publicKeys`, a raw `roles` key, a raw blacklist/whitelist entry) | it equals the address derived from `signature.publicKey`                                                                                                                                                                         |
| domain (`exclude.names`, a domain `roles` key, a domain blacklist/whitelist entry)             | it equals the wire `author.name` **and** resolves to the signer address. Resolution happens at match time with `cache: { maxAge: 0 }`, regardless of `pkc.resolveAuthorNames`. A resolver failure is a non-match, never an error |

There is no `exclude.address`; the schema rejects it. Private settings written before DB version 42 are migrated by `DbHandler._migrateOldSettings`, which splits the old `address` array by kind into `publicKeys` and `names`. See issue #267.

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

- **Already stored**: the request is a replay. The community answers `challengeSuccess: true` with the stored record and its `cid` (an *idempotent* verification) once per signature within a 10-minute window (`_duplicatePublicationAttempts`), and rejects further replays with `ERR_DUPLICATE_COMMENT` / `ERR_DUPLICATE_COMMENT_EDIT` / `ERR_DUPLICATE_COMMENT_MODERATION`. Nothing new is stored either way.
- **Exchange in flight**: a request for a signed publication whose challenge exchange is still running (`_inFlightPublicationExchanges`) waits for that exchange to settle instead of running the challenge again, and only then validates against the database. If the first exchange stored the publication, the waiter gets the idempotent verification. If the first exchange failed, the waiter runs its own exchange as a fresh attempt. Neither outcome consumes the replay allowance above, because the waiter was never a replay of a stored row. The lock is taken before validation, not after, so the duplicate check can never observe a row the overlapping exchange stored mid-validation and misclassify the request as a replay.
- **Stored between validation and storage**: if a duplicate is still detected when storing (the last-resort check), the community answers idempotently as well rather than failing an accepted publication.

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

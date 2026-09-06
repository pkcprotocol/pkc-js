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

| Message | Schema | Encrypted Payload |
|---------|--------|-------------------|
| `ChallengeRequestMessage` | `ChallengeRequestMessageSchema` | `DecryptedChallengeRequestSchema`: contains the publication + challenge options |
| `ChallengeMessage` | `ChallengeMessageSchema` | `DecryptedChallengeSchema`: contains `challenges[]` to solve |
| `ChallengeAnswerMessage` | `ChallengeAnswerMessageSchema` | `DecryptedChallengeAnswerSchema`: contains `challengeAnswers[]` |
| `ChallengeVerificationMessage` | `ChallengeVerificationMessageSchema` | `DecryptedChallengeVerificationSchema`: contains `comment` + `commentUpdate` on success |

## Encryption

- Uses **AES-GCM** with a shared secret derived from Ed25519 key exchange
- `ChallengeRequestMessage.encrypted`: encrypted with community's `encryption.publicKey`
- Each request uses a **new keypair**, `challengeRequestId` = multihash of the request's `signature.publicKey`
- See `docs/encryption.md` for low-level details

## Challenge Types

Built-in challenges defined in `src/runtime/node/community/challenges/`:

| Type | Description |
|------|-------------|
| `text-math` | Math problems (e.g., "2+3=?") |
| `question` | Q&A challenges |
| `publication-match` | Reject if publication doesn't match pattern |
| `blacklist` | Reject based on lists |
| `whitelist` | Allow only from lists |
| `fail` | Always fails (for testing) |

External challenges can be registered via `PKC.challenges` static object.

## Exclude Rules

Each challenge in `CommunityIpfsType.challenges[]` can have `exclude` rules that skip the challenge for certain authors:

- Author karma thresholds (postScore, replyScore)
- Account age
- Author role (admin, moderator)
- Whether previous challenges in the array were already passed
- Rate limiting

Exclude logic: `src/runtime/node/community/challenges/exclude/exclude.ts`

## ChallengeVerification Result

On **success**:
- `challengeSuccess: true`
- Encrypted payload contains `{ comment: CommentIpfs, commentUpdate: CommentUpdateForChallengeVerification }`
- The `commentUpdate` includes the assigned `cid`, `number`, `postNumber`

On **failure**:
- `challengeSuccess: false`
- `challengeErrors`: `{ [challengeIndex]: errorMessage }`
- `reason`: human-readable failure reason

## Duplicate and Overlapping Requests

A challenge request carries a signed publication, and the signature is the identity of that publication. A publisher may send the same signed publication more than once: after a lost verification, or as an automatic retry to another pubsub provider when no response arrives within its provider-switch threshold (the retry uses a new `challengeRequestId`). The community answers by signature, in `src/runtime/node/community/local-community/challenges.ts`:

- **Already stored**: the request is a replay. The community answers `challengeSuccess: true` with the stored record and its `cid` (an *idempotent* verification) once per signature within a 10-minute window (`_duplicatePublicationAttempts`), and rejects further replays with `ERR_DUPLICATE_COMMENT` / `ERR_DUPLICATE_COMMENT_EDIT` / `ERR_DUPLICATE_COMMENT_MODERATION`. Nothing new is stored either way.
- **Exchange in flight**: a request for a signed publication whose challenge exchange is still running (`_inFlightPublicationExchanges`) waits for that exchange to settle instead of running the challenge again, then re-validates. If the first exchange stored the publication, the waiter gets the idempotent verification. If the first exchange failed, the waiter runs its own exchange as a fresh attempt. Neither outcome consumes the replay allowance above, because the waiter was never a replay of a stored row.
- **Stored between validation and storage**: if a duplicate is still detected when storing (the last-resort check), the community answers idempotently as well rather than failing an accepted publication.

The idempotent verification rebuilds the record with `deriveCommentIpfsFromCommentTableRow` so it hashes to the stored `cid`; a post record must not carry `postCid`, and `extraProps` must be restored, or the author rejects the payload and never learns its `cid`.

## Community Challenge Configuration

The community owner configures challenges privately via `community.settings.challenges[]`. Only sanitized metadata is published publicly to `community.challenges[]`, the `options` field (containing answers, passwords, address lists) is always stripped. See [challenge-settings.md](challenge-settings.md) for the full private/public boundary.

## Key Files

| File | Purpose |
|------|---------|
| `src/pubsub-messages/schema.ts` | All message schemas |
| `src/pubsub-messages/types.ts` | Message type definitions |
| `src/runtime/node/community/challenges/index.ts` | Challenge processing logic (Node-only) |
| `src/runtime/node/community/challenges/exclude/exclude.ts` | Exclude rule evaluation |
| `src/publications/publication.ts` | Author-side publish flow |

## Common Mistakes

- Forgetting that challenge messages are encrypted, you can't read them without the shared secret.
- Confusing `CommunityIpfsType.challenges[]` (configuration) with `ChallengeMessage.challenges[]` (actual challenges to solve).
- Not handling `pendingApproval`, even on challenge success, the comment may go to mod queue.

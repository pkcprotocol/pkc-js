# Challenge/Response Flow

<!-- Note: "subplebbit" is being renamed to "community" — see RENAMING_GUIDE.md -->

## Summary

Before a publication is accepted by a subplebbit, the author must complete a challenge exchange. This is a 4-message encrypted conversation over pubsub between the author and the subplebbit. The subplebbit defines which challenges to use in its `challenges[]` configuration.

## The 4-Message Exchange

```
Author                              Subplebbit
  │                                     │
  │─── ChallengeRequestMessage ────────>│  Encrypted with subplebbit's public key
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
| `ChallengeRequestMessage` | `ChallengeRequestMessageSchema` | `DecryptedChallengeRequestSchema` — contains the publication + challenge options |
| `ChallengeMessage` | `ChallengeMessageSchema` | `DecryptedChallengeSchema` — contains `challenges[]` to solve |
| `ChallengeAnswerMessage` | `ChallengeAnswerMessageSchema` | `DecryptedChallengeAnswerSchema` — contains `challengeAnswers[]` |
| `ChallengeVerificationMessage` | `ChallengeVerificationMessageSchema` | `DecryptedChallengeVerificationSchema` — contains `comment` + `commentUpdate` on success |

## Encryption

- Uses **AES-GCM** with a shared secret derived from Ed25519 key exchange
- `ChallengeRequestMessage.encrypted`: encrypted with subplebbit's `encryption.publicKey`
- Each request uses a **new keypair** — `challengeRequestId` = multihash of the request's `signature.publicKey`
- See `docs/encryption.md` for low-level details

## Challenge Types

Built-in challenges defined in `src/runtime/node/subplebbit/challenges/`:

| Type | Description |
|------|-------------|
| `text-math` | Math problems (e.g., "2+3=?") |
| `question` | Q&A challenges |
| `publication-match` | Reject if publication doesn't match pattern |
| `blacklist` | Reject based on lists |
| `whitelist` | Allow only from lists |
| `fail` | Always fails (for testing) |

External challenges can be registered via `Plebbit.challenges` static object.

## Exclude Rules

Each challenge in `SubplebbitIpfs.challenges[]` can have `exclude` rules that skip the challenge for certain authors:

- Author karma thresholds (postScore, replyScore)
- Account age
- Author role (admin, moderator)
- Whether previous challenges in the array were already passed
- Rate limiting

Exclude logic: `src/runtime/node/subplebbit/challenges/exclude/exclude.ts`

## ChallengeVerification Result

On **success**:
- `challengeSuccess: true`
- Encrypted payload contains `{ comment: CommentIpfs, commentUpdate: CommentUpdateForChallengeVerification }`
- The `commentUpdate` includes the assigned `cid`, `number`, `postNumber`

On **failure**:
- `challengeSuccess: false`
- `challengeErrors`: `{ [challengeIndex]: errorMessage }`
- `reason`: human-readable failure reason

## Community Challenge Configuration

The community owner configures challenges privately via `community.settings.challenges[]`. Only sanitized metadata is published publicly to `community.challenges[]` — the `options` field (containing answers, passwords, address lists) is always stripped. See [challenge-settings.md](challenge-settings.md) for the full private/public boundary.

## Key Files

| File | Purpose |
|------|---------|
| `src/pubsub-messages/schema.ts` | All message schemas |
| `src/pubsub-messages/types.ts` | Message type definitions |
| `src/runtime/node/subplebbit/challenges/index.ts` | Challenge processing logic (Node-only) |
| `src/runtime/node/subplebbit/challenges/exclude/exclude.ts` | Exclude rule evaluation |
| `src/publications/publication.ts` | Author-side publish flow |

## Common Mistakes

- Forgetting that challenge messages are encrypted — you can't read them without the shared secret.
- Confusing `SubplebbitIpfs.challenges[]` (configuration) with `ChallengeMessage.challenges[]` (actual challenges to solve).
- Not handling `pendingApproval` — even on challenge success, the comment may go to mod queue.

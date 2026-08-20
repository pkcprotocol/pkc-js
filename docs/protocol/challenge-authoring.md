# Challenge Authoring

For authors of challenge packages: what pkc-js validates on your behalf, what your challenge has to
validate for itself, and where each of those runs.

## The two layers

A community owner's challenge configuration lives in `community.settings.challenges[i]`, a
`CommunityChallengeSetting`. It is checked in two layers before it takes effect.

| Layer | Who runs it | What it catches |
|---|---|---|
| Core `optionInputs` validation | pkc-js, for every challenge | Mechanical mistakes the challenge file's own `optionInputs` already describe |
| `validateChallengeSettings` | Your challenge, optional | Semantic mistakes only your challenge can recognize |

### Layer 1: what core validates for you

Core compares `options` and `publicOptions` against the `optionInputs` your `ChallengeFileFactory`
returned. You write no code for any of this.

| Check | Error code |
|---|---|
| An `options` key that no `optionInputs` entry declares | `ERR_CHALLENGE_OPTION_NOT_DECLARED_IN_OPTION_INPUTS` |
| A missing option whose `optionInputs` entry has `required: true` | `ERR_CHALLENGE_REQUIRED_OPTION_MISSING` |
| A `publicOptions` entry that no `optionInputs` entry declares | `ERR_CHALLENGE_PUBLIC_OPTION_NOT_DECLARED_IN_OPTION_INPUTS` |

An undeclared key can only be a typo. Nothing reads it and nothing publishes it, so it is dead config by
definition, and silently accepting it is how `anwser` instead of `answer` ends up rejecting every author
with no signal to the owner.

`required` means present, nothing more. An option counts as missing only when the key is absent; a key set
to `""` satisfies the check. Whether an empty value is meaningful for your challenge is your business, so
reject one in your `validateChallengeSettings` hook if it is not.

`optionInputs` is optional. A challenge file that declares none makes no promise about which options it
reads, so the two declared-key checks are skipped for it rather than rejecting everything it was given. If
you want core to catch typos for your challenge, declare your options.

### Layer 2: `validateChallengeSettings`

```ts
validateChallengeSettings?: (args: { challengeSettings: CommunityChallengeSetting }) => void
```

Add it to what your `ChallengeFileFactory` returns. Four rules:

-   **Optional.** A challenge with nothing semantic to check omits it. Layer 1 runs regardless.
-   **Sync, and no network.** It runs on every community start, so an async validator that hit a third party
    would turn that third party's outage into a startup problem. An API key check belongs in your
    `getChallenge()` failure path, where an outage degrades one publish instead of a boot.
-   **Rejection is a throw.** Throw anything, including a plain `new Error("matches is not valid JSON")`. No
    pkc-js import is needed. Core wraps it in a `PKCError` with code
    `ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED`, the original as `cause`, and your message in
    `details.validationError` (the part that survives RPC serialization, so write it for an owner to read).
-   **You get the whole `challengeSettings`.** Reject any field in it, `exclude` included.

Keep the factory itself cheap and non-throwing. The factory runs on load as well as on edit (start, DB
migration, community creation), so a factory that threw on invalid options would fail community startup
rather than the offending edit, and an owner who persisted a bad config would end up with a community that
will not boot. That separation is the whole reason this hook exists.

## Where validation runs

Both layers run at the same four points, with the same error codes on each. A consumer filtering on the
code cares about what is wrong, not about which path noticed.

| Path | Behavior |
|---|---|
| `community.edit()` | Rejected before anything is persisted. Failures are collected across every challenge and thrown as one `PKCError` with code `ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED_FOR_CHALLENGES`, whose `details.failures` is `{challengeIndex, challengeName, error}[]`, so an owner editing several challenges learns every failure at once |
| Community creation | Throws the same aggregated error. Nothing is persisted yet, so a throw is safe |
| `community.start()` | Emits one `error` event per invalid challenge, each carrying `{challengeIndex, challengeName, communityAddress}` in `details`. The community still starts, and the errors are re-emitted on every start until the config is fixed |
| DB migration | Silent. Surfacing config errors in the middle of a schema migration the owner did not initiate is the worst possible moment, and start catches the same problem seconds later |

Start never throws by design. A config that was persisted before a check existed, or one that a stricter
version of your challenge now rejects, must not take an owner's community down.

## Publication obligations

`publicOptions` (see [challenge-settings.md](challenge-settings.md)) lets the **owner** choose which of
your options are written into the published community record. Your hook is where you constrain that
choice, because a hook throw is a veto the owner cannot override.

-   **Forbid publication of a secret.** An option is a secret when publishing it breaks the challenge, not
    merely when it is private. `question.answer` is the only built-in case: published, anyone can pass the
    challenge. Throw if it appears in `publicOptions`.
-   **Require publication when clients need to read it.** A challenge that rejects publications for a reason
    the author cannot see in advance rejects every author. If your challenge only works when a UI can read a
    rule up front, throw when that option is _not_ in `publicOptions`.
-   **Stay silent otherwise.** Most options are private by default but legitimately publishable. A blacklist
    is moderation policy, and publishing it is transparency rather than a leak. That is the owner's call.

Because the hook is optional, these are obligations on you as a package author, not guarantees core can
enforce.

## Built-in challenges

| Challenge | What its hook validates |
|---|---|
| `question` | Refuses `answer` in `publicOptions` |
| `publication-match` | `matches` parses as JSON, is an array of `{propertyName, regexp}`, and every `regexp` compiles. No opinion on publication |
| `blacklist`, `whitelist` | Every comma separated `urls` entry parses with `new URL()` and uses `http:` or `https:`, since `fetch` is the only consumer and anything else fails silently forever. Every comma separated `addresses` entry is non-empty |
| `text-math`, `fail` | No hook |

## Upgrade note

Communities carrying config that has been quietly broken all along (a typo'd key, a missing required
option) begin emitting `error` events at boot once these checks ship. That is the intended outcome, but it
looks like a new bug to whoever sees it first.

## Key files

| File | Purpose |
|---|---|
| `src/community/schema.ts` | `ChallengeFileSchema` (where `validateChallengeSettings` is declared), `ChallengeOptionInputSchema`, `CommunityChallengeSettingSchema` |
| `src/runtime/node/community/challenges/validate-challenge-settings.ts` | Both layers, and the aggregation used by the edit and creation paths |
| `src/runtime/node/community/challenges/pkc-js-challenges/` | Built-in challenges and their hooks |
| `src/errors.ts` | The `ERR_CHALLENGE_*` codes listed above |

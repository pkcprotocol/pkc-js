# Challenge Settings: Private vs Public

## Summary

Community challenge configuration has a strict private/public boundary. `community.settings.challenges[]` is private: accessible only to the community owner, either via local SQLite or via RPC when connected to the RPC server that owns the community. Only `community.challenges[]`, a sanitized derivative, is published to IPNS. The `options` field (containing answers, passwords, address lists) is **private by default** and is never published wholesale.

The one exception is opt-in and owner-driven: the owner names individual options in `publicOptions`, and only those are copied into the published record as `community.challenges[i].publicOptions`. An owner who names nothing publishes nothing.

## The Two Schemas

| Aspect | Private (`CommunityChallengeSetting`) | Public (`CommunityChallenge`) |
|--------|---------------------------------------|-------------------------------|
| Access path | `community.settings.challenges[i]` | `community.challenges[i]` |
| Schema | `CommunityChallengeSettingSchema` | `CommunityChallengeSchema` |
| Defined in | `src/community/schema.ts` | `src/community/schema.ts` |
| Storage | SQLite (local) / RPC (remote owner) | IPNS (public) |
| Part of `CommunityIpfsSchema`? | No | Yes |

### Private: `CommunityChallengeSettingSchema`

```typescript
{
  path?: string                         // Path to custom challenge JS file
  name?: string                         // Built-in challenge name
  options?: Record<string, string>      // ** SENSITIVE, private by default **
  publicOptions?: string[]              // option names the owner opted into publishing
  exclude?: ChallengeExclude[]
  description?: string
  pendingApproval?: boolean
}
```

### Public: `CommunityChallengeSchema`

```typescript
{
  exclude?: ChallengeExclude[]
  description?: string
  challenge?: string                    // The prompt shown to the user (e.g. "2+2=?")
  type: string                          // e.g. "text/plain"
  caseInsensitive?: boolean
  pendingApproval?: boolean
  publicOptions?: Record<string, string> // only the options the owner opted into publishing
}
```

**Fields stripped during transformation:** `path`, `name`, `options`.
**Fields added from challenge file output:** `challenge`, `type`, `caseInsensitive`.
**Field derived from both:** `publicOptions` (the settings' `publicOptions` names resolved against the settings' `options`).

## The Transformation

`getCommunityChallengeFromCommunityChallengeSettings()` in `src/runtime/node/community/challenges/index.ts` converts private settings to public challenges. It:

1. Loads the challenge file (from `path` or built-in `name`)
2. Calls the `ChallengeFileFactory` with the full settings (including `options`)
3. Returns **only**: `exclude`, `description`, `challenge`, `type`, `caseInsensitive`, `pendingApproval`, `publicOptions`
4. `options`, `path`, and `name` are never copied to the output

### `publicOptions`

`derivePublicOptions()` builds the public record from the two private fields:

- An option is published only if the owner named it in `publicOptions` **and** actually set it in `options`. A named option that was never set is skipped.
- The field is omitted entirely, not emitted as `{}`, when nothing qualifies. A record from an owner who opted into nothing is byte-identical to one produced before `publicOptions` existed.
- Values stay `string`, matching the `options` contract. A structured ruleset ships as a JSON string, exactly as `publication-match` already does with its `matches` option.

Publication is the owner's decision, not the challenge developer's. A challenge package that must forbid or require publication of one of its options enforces that in its own validator rather than by owning the switch.

## Sensitive Options by Built-in Challenge

Two different things get called "sensitive", and `publicOptions` forces them apart.

### Secrets: publishing breaks the challenge

| Challenge | Option | Why publishing breaks it |
|-----------|--------|--------------------------|
| `question` | `answer` | Anyone reading the record could answer the challenge, so it stops filtering anything |

### Private by default: publishing is a legitimate owner choice

Not published unless the owner names the option, but naming it is a policy decision rather than a leak.

| Challenge | Option | What publishing it means |
|-----------|--------|--------------------------|
| `blacklist` | `addresses`, `urls` | Publishing the moderation policy is transparency; keeping it private stops a spammer reading the list |
| `whitelist` | `addresses`, `urls` | Same tradeoff as `blacklist` |
| `publication-match` | `matches` | Publishing lets a UI validate before the author burns a challenge attempt; keeping it private stops a spammer reading the patterns |
| `text-math` | `difficulty` | Only affects generation, harmless either way |

All built-in challenges also accept an `error` option (custom error message), not sensitive and private by default like everything else.

## Common Mistakes

- Logging or serializing `community.settings` in a context visible to users — `options` contains secrets, including the ones not named in `publicOptions`.
- Assuming `publicOptions` on the public record is the owner's `publicOptions` array — the public one is a `Record<string, string>` of resolved values, the private one is a `string[]` of names.
- Confusing `community.settings.challenges[]` (private config with `options`) with `community.challenges[]` (public, no `options`).
- Assuming `options` is available on a `RemoteCommunity` without RPC — it is only available to the community owner (locally or via RPC).

## Key Files

| File | Purpose |
|------|---------|
| `src/community/schema.ts` | Both `CommunityChallengeSettingSchema` and `CommunityChallengeSchema` |
| `src/runtime/node/community/challenges/index.ts` | `getCommunityChallengeFromCommunityChallengeSettings()` transformation and `derivePublicOptions()` |
| `src/runtime/node/community/challenges/pkc-js-challenges/` | Built-in challenge implementations with their `optionInputs` |
| `src/runtime/node/community/local-community.ts` | Where `this.challenges` is populated from `this.settings.challenges` |

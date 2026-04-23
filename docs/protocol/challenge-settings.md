# Challenge Settings: Private vs Public

<!-- Note: "subplebbit" is being renamed to "community" — see RENAMING_GUIDE.md -->

## Summary

Community challenge configuration has a strict private/public boundary. `community.settings.challenges[]` is private — accessible only to the community owner, either via local SQLite or via RPC when connected to the RPC server that owns the community. Only `community.challenges[]`, a sanitized derivative, is published to IPNS. The `options` field (containing answers, passwords, address lists) is **always stripped** before publication.

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
  options?: Record<string, string>      // ** SENSITIVE — never published **
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
}
```

**Fields stripped during transformation:** `path`, `name`, `options`.
**Fields added from challenge file output:** `challenge`, `type`, `caseInsensitive`.

## The Transformation

`getCommunityChallengeFromCommunityChallengeSettings()` in `src/runtime/node/community/challenges/index.ts` converts private settings to public challenges. It:

1. Loads the challenge file (from `path` or built-in `name`)
2. Calls the `ChallengeFileFactory` with the full settings (including `options`)
3. Returns **only**: `exclude`, `description`, `challenge`, `type`, `caseInsensitive`, `pendingApproval`
4. `options`, `path`, and `name` are never copied to the output

## Sensitive Options by Built-in Challenge

| Challenge | Option | Why it is sensitive |
|-----------|--------|---------------------|
| `question` | `answer` | The correct answer to the challenge question |
| `blacklist` | `addresses` | List of blacklisted author addresses |
| `blacklist` | `urls` | URLs to external blacklist sources |
| `whitelist` | `addresses` | List of whitelisted author addresses |
| `whitelist` | `urls` | URLs to external whitelist sources |
| `publication-match` | `matches` | JSON array of regex patterns used for filtering |
| `text-math` | `difficulty` | Not sensitive per se, but still private (only affects generation) |

All built-in challenges also accept an `error` option (custom error message) — not sensitive but private.

## Common Mistakes

- Logging or serializing `community.settings` in a context visible to users — `options` contains secrets.
- Confusing `community.settings.challenges[]` (private config with `options`) with `community.challenges[]` (public, no `options`).
- Assuming `options` is available on a `RemoteCommunity` without RPC — it is only available to the community owner (locally or via RPC).

## Key Files

| File | Purpose |
|------|---------|
| `src/community/schema.ts` | Both `CommunityChallengeSettingSchema` and `CommunityChallengeSchema` |
| `src/runtime/node/community/challenges/index.ts` | `getCommunityChallengeFromCommunityChallengeSettings()` transformation |
| `src/runtime/node/community/challenges/pkc-js-challenges/` | Built-in challenge implementations with their `optionInputs` |
| `src/runtime/node/community/local-community.ts` | Where `this.challenges` is populated from `this.settings.challenges` |

# Author wallet proofs (BSIP-22)

`author.wallets` lists wallets an author says they control. Each entry carries a proof. The proof format is specified by [BSIP-22](https://github.com/bitsocialnet/BSIPs/blob/master/BSIPS/bsip-22.md); this doc says what pkc-js does with it and gives a verifier to copy. Issue #566.

## What pkc-js does

| Where | What | Status |
|---|---|---|
| Community, on acceptance | Verifies every entry of `author.wallets` of every publication type (comment, vote, comment edit, comment moderation, community edit), after the publication's own signature is verified. An **invalid** entry rejects the publication, and the `reason` names the chain ticker. An **unknown** entry is accepted. | On |
| Publisher, before the exchange | `publication.publish()` runs the same check on the signed record after signing and throws `ERR_AUTHOR_WALLET_PROOF_IS_INVALID` (details: `chainTicker`, `reason`) before anything is sent; the instance is left `stopped` and can be retried. | On |
| Loading | Request and list schemas check only the shape of an entry (`address`, `timestamp`, `signature.signature`, `signature.type`). A missing `signature` or `type` is rejected there. BSIP-15 list loading never verifies a proof. | On |
| Library API | pkc-js exports no verifier. Copy the verifier file, see "Verifier to copy". | n/a |

Three outcomes, per entry:

- **valid**: `signature.type` is `eip191` and every rule holds.
- **invalid**: the entry lacks the shape above, or it is an `eip191` entry that breaks a rule.
- **unknown**: `signature.type` is any other string (a later BSIP may define it). Unproven, never a ground for rejection.

A client MUST verify an entry itself before it relies on it (shows the address as the author's wallet, counts holdings, sends funds). A community's acceptance is not a substitute, since a publication does not record whether its community checked.

## The signed string

```
{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"<12D3KooW... key address>","walletAddress":"<0x address, lowercase>","timestamp":<entry timestamp>}
```

`authorPublicKey` is the key address derived from the carrying record's `signature.publicKey`, never `author.name` or the runtime `author.address`. Signed with EIP-191 `personal_sign`; `v` is 27 or 28 and `s` is in the lower half of the curve order. The timestamp may not be more than 300 seconds ahead of the verifier's clock. Verification is stateless and needs no RPC.

## Verifier to copy

pkc-js exports no verifier, and this doc carries no second copy of one, so there is nothing to drift. Two places to copy from:

- `src/signer/author-wallet-proof.ts`: the verifier pkc-js runs. One small file, no imports besides `@noble/curves` and `@noble/hashes`. `verifyAuthorWalletEntry({ entry, authorPublicKey, nowSeconds })` returns `valid`, `invalid` (with a reason) or `unknown`. Copy the file as it is.
- `assets/verify-vectors.mjs` in the [BSIPs repo](https://github.com/bitsocialnet/BSIPs): the BSIP-22 reference check, written with Node built-ins only, for a verifier that cannot depend on `@noble`.

Whichever you use, run it against the BSIP-22 test vectors (`test/fixtures/author-wallet-proof/wallet-proof-vectors.json` here, copied from the BSIPs repo). `authorPublicKey` is the key address (`12D3KooW...`) of the `signature.publicKey` of the publication or list that carries the entry. The carrying record's own signature must be valid too: a proof counts only when its record is validly signed.

## Tests

- `test/node-and-browser/signatures/author-wallet-proof.test.ts`: the BSIP-22 vectors (`test/fixtures/author-wallet-proof/wallet-proof-vectors.json`, copied from the BSIPs repo) against `src/signer/author-wallet-proof.ts`.
- `test/node/community/author-wallet-proof.community.test.ts`: rejection of invalid proofs, acceptance of valid and unknown ones, and the local pre-publish check.

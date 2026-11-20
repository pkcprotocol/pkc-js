# Author wallet proofs (BSIP-22)

`author.wallets` lists wallets an author says they control. Each entry carries a proof. The proof format is specified by [BSIP-22](https://github.com/bitsocialnet/BSIPs/blob/master/BSIPS/bsip-22.md); this doc says what pkc-js does with it and gives a verifier to copy. Issue #566.

## What pkc-js does

| Where | What | Status |
|---|---|---|
| Community, on acceptance | Verifies every entry of `author.wallets` of every publication type (comment, vote, comment edit, comment moderation, community edit), after the publication's own signature is verified. An **invalid** entry rejects the publication, and the `reason` names the chain ticker. An **unknown** entry is accepted. | Implemented, **off** until `authorWalletProofEnforcement.enabled` is flipped (`src/signer/author-wallet-proof.ts`). Do not turn it on before challenges and clients use the BSIP-22 string, or every author with a saved wallet is rejected. |
| Publisher, before the exchange | `publication.publish()` runs the same check on the signed record after signing and throws `ERR_AUTHOR_WALLET_PROOF_IS_INVALID` (details: `chainTicker`, `reason`) before anything is sent; the instance is left `stopped` and can be retried. | Implemented, **off** with the same switch: a proof signed with the pre-BSIP-22 string reads as invalid, so checking first would block authors with a saved wallet in every community. |
| Loading | Request and list schemas check only the shape of an entry (`address`, `timestamp`, `signature.signature`, `signature.type`). A missing `signature` or `type` is rejected there. BSIP-15 list loading never verifies a proof. | On |
| Library API | pkc-js exports no verifier. Copy the snippet below. | n/a |

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

```js verify-author-wallet
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const HALF_ORDER = secp256k1.Point.Fn.ORDER >> 1n;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// entry: one value of author.wallets. authorPublicKey: key address (12D3KooW...) of the signature.publicKey of the
// publication or list that carries it. Returns "valid", "invalid" or "unknown".
export function verifyAuthorWalletEntry({ entry, authorPublicKey, nowSeconds = Math.floor(Date.now() / 1000) }) {
    if (!isObject(entry) || typeof entry.address !== "string" || !Number.isInteger(entry.timestamp)) return "invalid";
    const { address, timestamp, signature } = entry;
    if (!isObject(signature) || typeof signature.signature !== "string" || typeof signature.type !== "string") return "invalid";
    if (signature.type !== "eip191") return "unknown";
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || timestamp < 0 || timestamp > nowSeconds + 300) return "invalid";
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature.signature)) return "invalid";
    const bytes = hexToBytes(signature.signature.slice(2));
    if (bytes[64] !== 27 && bytes[64] !== 28) return "invalid";
    if (BigInt("0x" + bytesToHex(bytes.slice(32, 64))) > HALF_ORDER) return "invalid";
    const message = `{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"${authorPublicKey}","walletAddress":"${address.toLowerCase()}","timestamp":${timestamp}}`;
    const messageBytes = utf8ToBytes(message);
    const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
    const digest = keccak_256(new Uint8Array([...prefix, ...messageBytes]));
    try {
        const publicKey = secp256k1.Signature.fromBytes(bytes.slice(0, 64), "compact")
            .addRecoveryBit(bytes[64] - 27)
            .recoverPublicKey(digest)
            .toBytes(false);
        const recovered = "0x" + bytesToHex(keccak_256(publicKey.slice(1)).slice(12));
        return recovered === address.toLowerCase() ? "valid" : "invalid";
    } catch {
        return "invalid";
    }
}
```

The signature of the carrying publication must be valid too: a proof counts only when its record is validly signed. `test/node/signatures/author-wallet-proof-docs-snippet.test.ts` runs this block against the BSIP-22 vectors, so it cannot drift.

## Tests

- `test/node-and-browser/signatures/author-wallet-proof.test.ts`: the BSIP-22 vectors (`test/fixtures/author-wallet-proof/wallet-proof-vectors.json`, copied from the BSIPs repo) against `src/signer/author-wallet-proof.ts`.
- `test/node/community/author-wallet-proof.community.test.ts`: community acceptance with enforcement on and off, and the local pre-publish check.

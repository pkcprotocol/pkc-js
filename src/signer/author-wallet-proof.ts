// Verification of one `author.wallets` entry, as specified by BSIP-22 (Author Wallet Proofs).
//
// Dependency-free on purpose: this module imports only @noble/*, never util.ts or the runtime, so a
// schema module or a browser bundle can pull it in without a cycle (see AGENTS.md, Build).
// It is stateless and needs no network: an eip191 proof is one hash and one public-key recovery.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export type AuthorWalletEntryOutcome = { outcome: "valid" } | { outcome: "unknown" } | { outcome: "invalid"; reason: string };

// BSIP-22: a proof dated more than five minutes ahead of the verifier's clock is not valid yet.
export const AUTHOR_WALLET_PROOF_CLOCK_ALLOWANCE_SECONDS = 300;

const DOMAIN_SEPARATOR = "bitsocial-author-wallet";
const SECP256K1_HALF_ORDER = secp256k1.Point.Fn.ORDER >> 1n;
const WALLET_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_REGEX = /^0x[0-9a-fA-F]{130}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// The exact byte string the wallet signs. Built by concatenation: BSIP-22 fixes the field order and forbids
// relying on a serializer's key order.
export function getAuthorWalletProofMessage({
    authorPublicKey,
    walletAddress,
    timestamp
}: {
    authorPublicKey: string;
    walletAddress: string;
    timestamp: number;
}): string {
    return `{"domainSeparator":"${DOMAIN_SEPARATOR}","authorPublicKey":"${authorPublicKey}","walletAddress":"${walletAddress.toLowerCase()}","timestamp":${timestamp}}`;
}

// EIP-191 version 0x45 (personal_sign): keccak256("\x19Ethereum Signed Message:\n" + byteLength + message)
function hashPersonalMessage(message: string): Uint8Array {
    const messageBytes = utf8ToBytes(message);
    return keccak_256(concat(utf8ToBytes(`\x19Ethereum Signed Message:\n${messageBytes.length}`), messageBytes));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

// Returns the lowercase 0x address that signed `digest`, or undefined when no key recovers.
function recoverAddress({ digest, signatureHex }: { digest: Uint8Array; signatureHex: string }): string | undefined {
    const signatureBytes = hexToBytes(signatureHex.slice(2));
    const v = signatureBytes[64];
    const recovery = v - 27; // caller has already checked v is 27 or 28
    try {
        const signature = secp256k1.Signature.fromBytes(signatureBytes.slice(0, 64), "compact").addRecoveryBit(recovery);
        const publicKey = signature.recoverPublicKey(digest).toBytes(false); // 65 bytes: 0x04 || x || y
        return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(12))}`;
    } catch {
        return undefined;
    }
}

export function verifyAuthorWalletEntry({
    entry,
    authorPublicKey,
    nowSeconds
}: {
    entry: unknown;
    // the key address (12D3KooW...) derived from the carrying record's signature.publicKey. Never author.name or author.address
    authorPublicKey: string;
    nowSeconds: number;
}): AuthorWalletEntryOutcome {
    const invalid = (reason: string): AuthorWalletEntryOutcome => ({ outcome: "invalid", reason });

    // The shape BSIP-2 gives every entry is checked before the type, so an entry that lacks it is invalid
    // whatever its type. Members the BSIP does not define are ignored.
    if (!isRecord(entry)) return invalid("entry is not an object");
    const { address, timestamp, signature } = entry;
    if (typeof address !== "string") return invalid("address is not a string");
    if (typeof timestamp !== "number" || !Number.isInteger(timestamp)) return invalid("timestamp is not an integer");
    if (!isRecord(signature)) return invalid("signature is not an object");
    if (typeof signature.signature !== "string") return invalid("signature.signature is not a string");
    if (typeof signature.type !== "string") return invalid("signature.type is not a string");

    // A type this BSIP does not define is unproven, not invalid: rejecting it would make every later
    // signature type fail in every community that has not upgraded.
    if (signature.type !== "eip191") return { outcome: "unknown" };

    if (!WALLET_ADDRESS_REGEX.test(address)) return invalid("address is not a 0x address with 40 hex digits");
    if (timestamp < 0) return invalid("timestamp is negative");
    if (timestamp > nowSeconds + AUTHOR_WALLET_PROOF_CLOCK_ALLOWANCE_SECONDS)
        return invalid(`timestamp is more than ${AUTHOR_WALLET_PROOF_CLOCK_ALLOWANCE_SECONDS} seconds in the future`);

    if (!SIGNATURE_REGEX.test(signature.signature)) return invalid("signature is not 65 bytes as 0x and 130 hex digits");
    const signatureBytes = hexToBytes(signature.signature.slice(2));
    const v = signatureBytes[64];
    // Recovery libraries accept 0/1 and a high s, so both are checked here, not left to the library
    if (v !== 27 && v !== 28) return invalid("signature v is not 27 or 28");
    const s = BigInt(`0x${bytesToHex(signatureBytes.slice(32, 64))}`);
    if (s > SECP256K1_HALF_ORDER) return invalid("signature s is in the upper half of the curve order");

    const message = getAuthorWalletProofMessage({ authorPublicKey, walletAddress: address, timestamp });
    const recovered = recoverAddress({ digest: hashPersonalMessage(message), signatureHex: signature.signature });
    if (!recovered || recovered !== address.toLowerCase()) return invalid("signature does not recover the wallet address");

    return { outcome: "valid" };
}

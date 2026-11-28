// BSIP-10, "Key addresses". A key address is derived from a 32-byte Ed25519 public key: the libp2p PublicKey protobuf
// (0x08 0x01 0x12 0x20 and the key), wrapped in an identity multihash (0x00 0x24), encoded in base58btc with no
// multibase prefix. That is 52 characters starting with 12D3KooW, the form signer.address and community.publicKey use.
//
// Every wire field and configuration value that holds a key address takes this form only. The base36 and base32 CID
// encodings of the same key (k51..., bafz...) and any other multihash (Qm...) are a different string, and key
// addresses are compared as exact strings, so accepting them anywhere would create identities that match nothing.
//
// Kept free of src/util.ts and of the runtime: zod schema modules import it (see AGENTS.md on schema import cycles).
import { base58btc } from "multiformats/bases/base58";

const KEY_ADDRESS_LENGTH = 52;
const KEY_ADDRESS_BYTES_PREFIX = [0x00, 0x24, 0x08, 0x01, 0x12, 0x20]; // identity multihash of 36 bytes, Ed25519 protobuf header
const KEY_ADDRESS_BYTES_LENGTH = KEY_ADDRESS_BYTES_PREFIX.length + 32;

export function isKeyAddress(value: unknown): value is string {
    if (typeof value !== "string" || value.length !== KEY_ADDRESS_LENGTH) return false;
    let bytes: Uint8Array;
    try {
        bytes = base58btc.decode(`z${value}`);
    } catch {
        return false;
    }
    if (bytes.length !== KEY_ADDRESS_BYTES_LENGTH) return false;
    return KEY_ADDRESS_BYTES_PREFIX.every((byte, index) => bytes[index] === byte);
}

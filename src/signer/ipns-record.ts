import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromString } from "@libp2p/peer-id";
import { getIpfsKeyFromPrivateKey } from "./util.js";
import type { SignerType } from "./types.js";

// The validity (EOL) an anchor record is signed with. Every IPNS record carries one, and the ipns
// validator rejects expired records on every resolution path, so "infinite" is not an option: this is
// a single far-future constant instead, shared by every call site so an anchor's liveness never
// depends on which code path signed it. Re-signing before this lapses is the owner's obligation, and
// the owner is offline by design, hence a horizon long enough that only rotation brings them back.
// See docs/protocol/delegated-ipns.md.
export const ANCHOR_IPNS_RECORD_LIFETIME_MS = 100 * 365 * 24 * 60 * 60 * 1000; // ~100 years

// Signs an anchor record An -> Mn with the anchor's private key As.
//
// This is the one step of delegation setup the node cannot do: it is the owner proving, with a key the
// node has never seen, that this minter may publish the community. It runs on the client, so it must
// stay browser-safe — a browser holding As is the primary case, and anything node-only imported here
// breaks the browser build.
//
// `sequence` must come from prepareAnchorPublish (or be 0 for a community's first anchor record).
// Never sign an equal sequence: with this lifetime the validity tiebreak is a tie too, so which of two
// equal-sequence records wins is undefined in practice.
export async function createAnchorIpnsRecord({
    anchorSigner,
    minterIpnsName,
    sequence
}: {
    anchorSigner: Pick<SignerType, "privateKey">;
    minterIpnsName: string;
    // Decimal string included on purpose: prepareAnchorPublish returns nextSequence as a string, and
    // every sequence in this feature travels as one precisely so a value above Number.MAX_SAFE_INTEGER
    // survives the trip. A caller who had to write Number(nextSequence) to satisfy this type would lose
    // that precision before the value ever reached us. BigInt() parses decimal strings exactly.
    sequence: string | number | bigint;
}): Promise<Uint8Array> {
    const { createIPNSRecord, marshalIPNSRecord } = await import("ipns");

    if (typeof minterIpnsName !== "string" || !minterIpnsName) throw Error("minterIpnsName must be a non-empty IPNS name");
    peerIdFromString(minterIpnsName); // throws if it is not an IPNS name, before we sign anything pointing at it

    const seq = BigInt(sequence);
    if (seq < 0n) throw Error("sequence of an anchor IPNS record can not be negative");

    const ipfsKey = await getIpfsKeyFromPrivateKey(anchorSigner.privateKey);
    const anchorPrivateKey = privateKeyFromProtobuf(new Uint8Array(ipfsKey));

    const record = await createIPNSRecord(anchorPrivateKey, `/ipns/${minterIpnsName}`, seq, ANCHOR_IPNS_RECORD_LIFETIME_MS);
    return marshalIPNSRecord(record);
}

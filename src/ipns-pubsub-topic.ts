import { peerIdFromString } from "@libp2p/peer-id";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";

// Relocated out of util.ts (issue #120, slim ./client import). util.ts is imported by nearly every
// module — including the static graph of the RPC-only ./client entry — and this was its only
// @libp2p/peer-id use (~380ms to import). Only community/helia code paths call it, and those are all
// loaded lazily, so keeping the peer-id dependency here means a bare RPC import never pays for it.
export function ipnsNameToIpnsOverPubsubTopic(ipnsName: string) {
    // for ipns over pubsub, the topic is '/record/' + Base64Url(Uint8Array('/ipns/') + Uint8Array('12D...'))
    // https://github.com/ipfs/helia/blob/1561e4a106074b94e421a77b0b8776b065e48bc5/packages/ipns/src/routing/pubsub.ts#L169
    const ipnsNamespaceBytes = new TextEncoder().encode("/ipns/");
    const ipnsNameBytes = peerIdFromString(ipnsName).toMultihash().bytes; // accepts base58 (12D...) and base36 (k51...)
    const ipnsNameBytesWithNamespace = new Uint8Array(ipnsNamespaceBytes.length + ipnsNameBytes.length);
    ipnsNameBytesWithNamespace.set(ipnsNamespaceBytes, 0);
    ipnsNameBytesWithNamespace.set(ipnsNameBytes, ipnsNamespaceBytes.length);
    const pubsubTopic = "/record/" + uint8ArrayToString(ipnsNameBytesWithNamespace, "base64url");
    return pubsubTopic;
}

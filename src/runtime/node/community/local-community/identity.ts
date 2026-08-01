import type { LocalCommunity } from "../local-community.js";

// The public key clients address this community by: the anchor (An) on a delegated community, the
// signing key on a normal one. Never the minter on a delegated community — that is
// community.signer.address, and it rotates, so anything durable (stored publications, acceptance
// checks, a domain's TXT record) must be keyed by this instead.
//
// Prefer this over community.publicKey on the write side. They agree wherever both are defined, but
// publicKey is derived state and is undefined on a domain-addressed community that has not published
// its first record yet, which would silently turn an acceptance check into a rejection.
// See docs/protocol/delegated-ipns.md.
export function communityIdentityPublicKey(community: LocalCommunity): string {
    return community.anchor?.publicKey ?? community.signer.address;
}

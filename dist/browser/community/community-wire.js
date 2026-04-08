import * as remeda from "remeda";
import { getPKCAddressFromPublicKeySync } from "../signer/util.js";
import { isStringDomain } from "../util.js";
const runtimeOnlyCommunityFields = ["address", "publicKey", "shortAddress", "nameResolved"];
export function omitRuntimeCommunityFields(community) {
    if (!community)
        return {};
    return remeda.omit(community, runtimeOnlyCommunityFields);
}
export function cleanWireCommunity(community) {
    const wireCommunity = omitRuntimeCommunityFields(community);
    if (remeda.isEmpty(wireCommunity))
        return undefined;
    return wireCommunity;
}
export function getCommunityNameFromWire(community) {
    const wireCommunity = omitRuntimeCommunityFields(community);
    if (typeof wireCommunity.name === "string")
        return wireCommunity.name;
    // Backward compat: old records have address as a domain name
    if (typeof community?.address === "string" && isStringDomain(community.address))
        return community.address;
    return undefined;
}
export function getCommunityDomainFromWire(community) {
    const name = getCommunityNameFromWire(community);
    return typeof name === "string" && isStringDomain(name) ? name : undefined;
}
export function buildRuntimeCommunity({ communityRecord, signaturePublicKey }) {
    const publicKey = getPKCAddressFromPublicKeySync(signaturePublicKey);
    const name = getCommunityNameFromWire(communityRecord);
    return {
        ...(name ? { name } : undefined),
        address: name || publicKey,
        publicKey
    };
}
//# sourceMappingURL=community-wire.js.map
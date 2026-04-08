import { isStringDomain } from "../util.js";
/**
 * Extract communityPublicKey from a wire record.
 * New format: returns communityPublicKey directly.
 * Old format fallback: if subplebbitAddress is an IPNS key (not a domain), returns it.
 */
export function getCommunityPublicKeyFromWire(pub) {
    if (typeof pub?.communityPublicKey === "string")
        return pub.communityPublicKey;
    // Old format: subplebbitAddress that is an IPNS key (not a domain)
    if (typeof pub?.subplebbitAddress === "string" && !isStringDomain(pub.subplebbitAddress))
        return pub.subplebbitAddress;
    return undefined;
}
/**
 * Extract communityName from a wire record.
 * New format: returns communityName directly.
 * Old format fallback: if subplebbitAddress is a domain, returns it.
 */
export function getCommunityNameFromWire(pub) {
    if (typeof pub?.communityName === "string")
        return pub.communityName;
    // Old format: subplebbitAddress that is a domain
    if (typeof pub?.subplebbitAddress === "string" && isStringDomain(pub.subplebbitAddress))
        return pub.subplebbitAddress;
    return undefined;
}
/**
 * Get the community address from a record that may be in old or new format.
 * Returns communityName || communityPublicKey || subplebbitAddress.
 * Used in verification to check address match regardless of format.
 */
export function getCommunityAddressFromRecord(pub) {
    if (typeof pub?.communityAddress === "string")
        return pub.communityAddress;
    if (typeof pub?.communityName === "string")
        return pub.communityName;
    if (typeof pub?.communityPublicKey === "string")
        return pub.communityPublicKey;
    if (typeof pub?.subplebbitAddress === "string")
        return pub.subplebbitAddress;
    return undefined;
}
/**
 * Build runtime community fields from a wire record (old or new format).
 * Returns { communityAddress, communityPublicKey?, communityName? }.
 */
export function buildRuntimeCommunityFields({ publication }) {
    const communityPublicKey = getCommunityPublicKeyFromWire(publication);
    const communityName = getCommunityNameFromWire(publication);
    const communityAddress = communityName || communityPublicKey;
    if (!communityAddress)
        throw Error("Cannot derive communityAddress: no communityName, communityPublicKey, or subplebbitAddress found");
    return {
        communityAddress,
        ...(communityPublicKey ? { communityPublicKey } : undefined),
        ...(communityName ? { communityName } : undefined)
    };
}
/**
 * Extract communityPublicKey and communityName from a loaded community instance.
 * Called during publish() to fill wire fields before signing.
 */
export function normalizeCommunityInputFromCommunity({ communityInstance }) {
    return {
        communityPublicKey: communityInstance.publicKey,
        ...(communityInstance.name ? { communityName: communityInstance.name } : undefined)
    };
}
/**
 * Pre-process an old CommentIpfs record that has subplebbitAddress but no communityPublicKey/communityName.
 * Converts subplebbitAddress into the appropriate new fields.
 * Mutates and returns the record.
 */
export function preprocessCommentIpfsBackwardCompat(record) {
    if (record.subplebbitAddress && !record.communityPublicKey && !record.communityName) {
        if (isStringDomain(record.subplebbitAddress)) {
            record.communityName = record.subplebbitAddress;
        }
        else {
            record.communityPublicKey = record.subplebbitAddress;
        }
        delete record.subplebbitAddress;
    }
    return record;
}
//# sourceMappingURL=publication-community.js.map
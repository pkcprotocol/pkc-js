type LoosePublicationRecord = {
    communityAddress?: string;
    communityPublicKey?: string;
    communityName?: string;
    subplebbitAddress?: string;
} & Record<string, unknown>;
/**
 * Extract communityPublicKey from a wire record.
 * New format: returns communityPublicKey directly.
 * Old format fallback: if subplebbitAddress is an IPNS key (not a domain), returns it.
 */
export declare function getCommunityPublicKeyFromWire(pub?: LoosePublicationRecord): string | undefined;
/**
 * Extract communityName from a wire record.
 * New format: returns communityName directly.
 * Old format fallback: if subplebbitAddress is a domain, returns it.
 */
export declare function getCommunityNameFromWire(pub?: LoosePublicationRecord): string | undefined;
/**
 * Get the community address from a record that may be in old or new format.
 * Returns communityName || communityPublicKey || subplebbitAddress.
 * Used in verification to check address match regardless of format.
 */
export declare function getCommunityAddressFromRecord(pub?: LoosePublicationRecord): string | undefined;
/**
 * Build runtime community fields from a wire record (old or new format).
 * Returns { communityAddress, communityPublicKey?, communityName? }.
 */
export declare function buildRuntimeCommunityFields({ publication }: {
    publication?: LoosePublicationRecord;
}): {
    communityAddress: string;
    communityPublicKey?: string;
    communityName?: string;
};
/**
 * Extract communityPublicKey and communityName from a loaded community instance.
 * Called during publish() to fill wire fields before signing.
 */
export declare function normalizeCommunityInputFromCommunity({ communityInstance }: {
    communityInstance: {
        publicKey: string;
        name?: string;
    };
}): {
    communityPublicKey: string;
    communityName?: string;
};
/**
 * Pre-process an old CommentIpfs record that has subplebbitAddress but no communityPublicKey/communityName.
 * Converts subplebbitAddress into the appropriate new fields.
 * Mutates and returns the record.
 */
export declare function preprocessCommentIpfsBackwardCompat(record: Record<string, unknown>): Record<string, unknown>;
export {};

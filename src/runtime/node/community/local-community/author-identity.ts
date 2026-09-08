import Logger from "../../../../logger.js";
import { isStringDomain } from "../../../../util.js";
import { getPKCAddressFromPublicKeySync } from "../../../../signer/util.js";
import { getAuthorNameFromWire } from "../../../../publications/publication-author.js";
import { PKCError } from "../../../../pkc-error.js";
import { messages } from "../../../../errors.js";
import type { LocalCommunity } from "../local-community.js";

// Author identity matching for the community side (challenge excludes, roles, blacklist/whitelist).
//
// A publication carries two author identities: the signer, derived from `signature.publicKey`, which is
// unforgeable; and an optional wire `author.name`, a domain the publisher merely claims. The runtime
// `author.address` is `name || signerAddress`, so any matcher comparing it lexically can be satisfied by a
// signer claiming a domain it does not own. This module is the one place that decides whether a configured
// identity string (a role key, an exclude entry, a list entry) refers to the author of a publication:
//
// - a key-derived address matches iff it equals the signer address
// - a domain matches iff it equals the wire name AND resolves to the signer address, resolved here regardless
//   of `pkc.resolveAuthorNames` (that flag only controls the optional identity check in publication validation)
//
// A resolver problem still never throws out of a matcher: an identity that cannot be verified does not match.
// But the matcher now reports WHY it did not match, so a caller that is about to reject can tell the publisher
// that the community's node could not resolve the name, instead of letting them see the challenge's own
// "you are not the owner" text. A domain that resolves to somebody else stays a silent non-match: that is an
// impostor, not a misconfiguration, and it gets no explanation. See issues #267 and #353.

/** Why a domain identity that named this publication's author failed to verify. Never an impostor. */
export type NameIdentityFailure = {
    /** The reason to publish to the author if this non-match is what gets their publication rejected. */
    reason: messages;
    /** The underlying resolver error, if any. Node-side only: the wire verification carries `reason` alone. */
    error?: unknown;
};

export type IdentityMatchOutcome = { matched: true } | { matched: false; nameFailure?: NameIdentityFailure };

export type AuthorIdentityMatcher = {
    signerAddress: string;
    wireName: string | undefined;
    /** Does `identity` (a key-derived address or a domain) refer to this publication's author? */
    matchesIdentity: (identity: string) => Promise<IdentityMatchOutcome>;
    /** Does any of `identities` refer to this publication's author? Resolves the wire name at most once. */
    matchesAnyIdentity: (identities: Iterable<string>) => Promise<IdentityMatchOutcome>;
};

const NO_MATCH: IdentityMatchOutcome = { matched: false };
const MATCH: IdentityMatchOutcome = { matched: true };

export function createAuthorIdentityMatcher({
    community,
    publication
}: {
    community: Pick<LocalCommunity, "_clientsManager" | "_pkc">;
    publication: { author?: Parameters<typeof getAuthorNameFromWire>[0]; signature: { publicKey: string } };
}): AuthorIdentityMatcher {
    const log = Logger("pkc-js:local-community:author-identity");
    const signerAddress = getPKCAddressFromPublicKeySync(publication.signature.publicKey);
    const wireName = getAuthorNameFromWire(publication.author);

    let nameOutcomePromise: Promise<IdentityMatchOutcome> | undefined;
    const nameResolvesToSigner = (): Promise<IdentityMatchOutcome> => {
        if (!wireName || !isStringDomain(wireName)) return Promise.resolve(NO_MATCH);
        if (!nameOutcomePromise)
            nameOutcomePromise = (async (): Promise<IdentityMatchOutcome> => {
                try {
                    const { resolvedAuthorName } = await community._clientsManager.resolveAuthorNameIfNeeded({
                        authorName: wireName,
                        abortSignal: AbortSignal.timeout(community._pkc._timeouts["resolve-author-name"]),
                        // Identity grants authority (role, owner exclude, whitelist), so it must reflect current state: bypass cache.
                        cache: { maxAge: 0 }
                    });
                    if (resolvedAuthorName === signerAddress) return MATCH;
                    if (resolvedAuthorName === null) {
                        // The resolvers answered and there is no record. Definitive, and the publisher's to fix.
                        log("Author name has no record while matching identity", wireName);
                        return { matched: false, nameFailure: { reason: messages.ERR_AUTHOR_NAME_HAS_NO_RECORD } };
                    }
                    // Resolved to somebody else: an impostor claiming a listed domain. No explanation is owed.
                    return NO_MATCH;
                } catch (e) {
                    const code = e instanceof PKCError ? e.code : undefined;
                    log("Failed to resolve author name while matching identity", wireName, code, e);
                    const reason =
                        code === "ERR_NO_RESOLVER_FOR_NAME"
                            ? messages.ERR_COMMUNITY_HAS_NO_RESOLVER_FOR_AUTHOR_NAME_TLD
                            : code === "ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS"
                              ? messages.ERR_AUTHOR_NAME_RECORD_IS_NOT_A_VALID_KEY
                              : messages.ERR_COMMUNITY_FAILED_TO_RESOLVE_AUTHOR_NAME;
                    return { matched: false, nameFailure: { reason, error: e } };
                }
            })();
        return nameOutcomePromise;
    };

    const matchesIdentity = async (identity: string): Promise<IdentityMatchOutcome> => {
        if (!isStringDomain(identity)) return identity === signerAddress ? MATCH : NO_MATCH;
        if (identity !== wireName) return NO_MATCH;
        return nameResolvesToSigner();
    };

    const matchesAnyIdentity = async (identities: Iterable<string>): Promise<IdentityMatchOutcome> => {
        let nameListed = false;
        // Key comparison first and in full: it is free, while a domain identity costs a fresh network resolve
        // with maxAge 0. A moderator listed under both their public key and their domain must never pay for the
        // domain lookup, and must stay authorized while the resolver is down. See issue #354.
        for (const identity of identities) {
            if (identity === signerAddress) return MATCH;
            if (wireName && identity === wireName) nameListed = true;
        }
        return nameListed ? nameResolvesToSigner() : NO_MATCH;
    };

    return { signerAddress, wireName, matchesIdentity, matchesAnyIdentity };
}

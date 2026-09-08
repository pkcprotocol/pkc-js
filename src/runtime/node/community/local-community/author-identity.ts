import Logger from "../../../../logger.js";
import { isStringDomain } from "../../../../util.js";
import { getPKCAddressFromPublicKeySync } from "../../../../signer/util.js";
import { getAuthorNameFromWire } from "../../../../publications/publication-author.js";
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
// Resolver failures never throw out of a matcher: an identity that cannot be verified does not match.
// See issue #267.

export type AuthorIdentityMatcher = {
    signerAddress: string;
    wireName: string | undefined;
    /** Does `identity` (a key-derived address or a domain) refer to this publication's author? */
    matchesIdentity: (identity: string) => Promise<boolean>;
    /** Does any of `identities` refer to this publication's author? Resolves the wire name at most once. */
    matchesAnyIdentity: (identities: Iterable<string>) => Promise<boolean>;
};

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

    let nameResolvesToSignerPromise: Promise<boolean> | undefined;
    const nameResolvesToSigner = (): Promise<boolean> => {
        if (!wireName || !isStringDomain(wireName)) return Promise.resolve(false);
        if (!nameResolvesToSignerPromise)
            nameResolvesToSignerPromise = (async () => {
                try {
                    const { resolvedAuthorName } = await community._clientsManager.resolveAuthorNameIfNeeded({
                        authorName: wireName,
                        abortSignal: AbortSignal.timeout(community._pkc._timeouts["resolve-author-name"]),
                        // Identity grants authority (role, owner exclude, whitelist), so it must reflect current state: bypass cache.
                        cache: { maxAge: 0 }
                    });
                    return resolvedAuthorName === signerAddress;
                } catch (e) {
                    log("Failed to resolve author name while matching identity, treating as no match", wireName, e);
                    return false;
                }
            })();
        return nameResolvesToSignerPromise;
    };

    const matchesIdentity = async (identity: string): Promise<boolean> => {
        if (!isStringDomain(identity)) return identity === signerAddress;
        if (identity !== wireName) return false;
        return nameResolvesToSigner();
    };

    const matchesAnyIdentity = async (identities: Iterable<string>): Promise<boolean> => {
        let nameListed = false;
        for (const identity of identities) {
            if (identity === signerAddress) return true;
            if (wireName && identity === wireName) nameListed = true;
        }
        return nameListed ? nameResolvesToSigner() : false;
    };

    return { signerAddress, wireName, matchesIdentity, matchesAnyIdentity };
}

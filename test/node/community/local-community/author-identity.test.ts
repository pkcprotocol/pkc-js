// Unit tests for the community-side author identity matcher.
//
// Two behaviours are pinned here that no integration test can pin cheaply:
//
// 1. Ordering (issue #354). A key-derived role/exclude entry is compared for free; a domain entry costs a
//    fresh network resolve with maxAge 0. A moderator listed under both must match on the key and never
//    touch the resolver, and must stay authorized while the resolver is down. Nothing tested this, so a
//    refactor that resolved eagerly, or that awaited the domain before scanning the keys, would have passed
//    every existing test while adding a resolver round trip (and a resolver dependency) to every moderator
//    publication.
// 2. Why a domain did not match (issue #353). A resolver problem and an impostor are different facts: the
//    first is the community node's to fix and gets reported to the publisher, the second gets nothing.

import { describe, it, expect, vi } from "vitest";
import { createAuthorIdentityMatcher } from "../../../../dist/node/runtime/node/community/local-community/author-identity.js";
import { PKCError } from "../../../../dist/node/pkc-error.js";
import { messages } from "../../../../dist/node/errors.js";
import signers from "../../../fixtures/signers.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

const owner = signers[6];
const impostor = signers[7];
const ownerDomain = "owner-354.bso";

// `resolve` receives the name and returns what resolveAuthorNameIfNeeded would: an address, null for "no
// record", or a throw.
const buildMatcher = ({
    signer = owner,
    name,
    resolve
}: {
    signer?: (typeof signers)[number];
    name?: string;
    resolve?: (authorName: string) => Promise<string | null>;
}) => {
    const resolveAuthorNameIfNeeded = vi.fn(async ({ authorName }: { authorName: string }) => ({
        resolvedAuthorName: await (resolve ?? (async () => owner.address))(authorName)
    }));
    const community = {
        _clientsManager: { resolveAuthorNameIfNeeded },
        _pkc: { _timeouts: { "resolve-author-name": 5000 } }
    } as unknown as LocalCommunity;
    const matcher = createAuthorIdentityMatcher({
        community,
        publication: { author: name ? { address: name } : undefined, signature: { publicKey: signer.publicKey } }
    });
    return { matcher, resolveAuthorNameIfNeeded };
};

describe("author-identity: a public-key entry short-circuits before any name resolution (#354)", () => {
    it("matches on the key without calling the resolver, even though the domain is also listed", async () => {
        const { matcher, resolveAuthorNameIfNeeded } = buildMatcher({ name: ownerDomain });

        const result = await matcher.matchesAnyIdentity([ownerDomain, owner.address]);

        expect(result.matched).to.equal(true);
        expect(resolveAuthorNameIfNeeded).not.toHaveBeenCalled();
    });

    it("still matches on the key when the resolver is down", async () => {
        const { matcher, resolveAuthorNameIfNeeded } = buildMatcher({
            name: ownerDomain,
            resolve: async () => {
                throw new PKCError("ERR_ALL_NAME_RESOLVERS_FAILED", { address: ownerDomain });
            }
        });

        // A moderator's authority comes from the key they signed with. A resolver outage must not remove it.
        const result = await matcher.matchesAnyIdentity([ownerDomain, owner.address]);

        expect(result.matched).to.equal(true);
        expect(resolveAuthorNameIfNeeded).not.toHaveBeenCalled();
    });

    it("scans every entry for a key match before resolving, whatever order they are listed in", async () => {
        const { matcher, resolveAuthorNameIfNeeded } = buildMatcher({ name: ownerDomain });

        // Domain first: an implementation that awaited each entry in turn would resolve before reaching the key.
        const result = await matcher.matchesAnyIdentity(new Set([ownerDomain, "someone-else.bso", owner.address]));

        expect(result.matched).to.equal(true);
        expect(resolveAuthorNameIfNeeded).not.toHaveBeenCalled();
    });

    it("resolves the name at most once across repeated calls", async () => {
        const { matcher, resolveAuthorNameIfNeeded } = buildMatcher({ name: ownerDomain });

        expect((await matcher.matchesAnyIdentity([ownerDomain])).matched).to.equal(true);
        expect((await matcher.matchesAnyIdentity([ownerDomain])).matched).to.equal(true);
        expect((await matcher.matchesIdentity(ownerDomain)).matched).to.equal(true);

        expect(resolveAuthorNameIfNeeded).toHaveBeenCalledTimes(1);
    });

    it("does not resolve a listed domain the publisher did not claim", async () => {
        const { matcher, resolveAuthorNameIfNeeded } = buildMatcher({ name: undefined });

        const anyResult = await matcher.matchesAnyIdentity([ownerDomain]);
        const oneResult = await matcher.matchesIdentity(ownerDomain);

        expect(anyResult.matched).to.equal(false);
        expect(oneResult.matched).to.equal(false);
        expect(resolveAuthorNameIfNeeded).not.toHaveBeenCalled();
    });
});

describe("author-identity: why a domain did not match (#353)", () => {
    it("matches when the claimed domain resolves to the signer", async () => {
        const { matcher } = buildMatcher({ name: ownerDomain, resolve: async () => owner.address });
        expect((await matcher.matchesAnyIdentity([ownerDomain])).matched).to.equal(true);
    });

    it("gives an impostor no explanation at all", async () => {
        const { matcher } = buildMatcher({ signer: impostor, name: ownerDomain, resolve: async () => owner.address });

        const result = await matcher.matchesAnyIdentity([ownerDomain]);

        // The domain resolved fine, to somebody else. Nothing about the community's configuration is wrong,
        // and saying anything here would tell a stranger about the state of a name they do not own.
        expect(result).to.deep.equal({ matched: false });
    });

    for (const [label, thrown, expectedReason] of [
        [
            "every resolver errored",
            new PKCError("ERR_ALL_NAME_RESOLVERS_FAILED", { address: ownerDomain }),
            messages.ERR_COMMUNITY_FAILED_TO_RESOLVE_AUTHOR_NAME
        ],
        [
            "no resolver handles the TLD",
            new PKCError("ERR_NO_RESOLVER_FOR_NAME", { address: ownerDomain }),
            messages.ERR_COMMUNITY_HAS_NO_RESOLVER_FOR_AUTHOR_NAME_TLD
        ],
        [
            "the record is not a valid key",
            new PKCError("ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS", { address: ownerDomain }),
            messages.ERR_AUTHOR_NAME_RECORD_IS_NOT_A_VALID_KEY
        ],
        ["the resolve timed out", new Error("The operation was aborted"), messages.ERR_COMMUNITY_FAILED_TO_RESOLVE_AUTHOR_NAME]
    ] as const) {
        it(`reports the reason when ${label}`, async () => {
            const { matcher } = buildMatcher({
                name: ownerDomain,
                resolve: async () => {
                    throw thrown;
                }
            });

            const result = await matcher.matchesAnyIdentity([ownerDomain]);

            expect(result.matched).to.equal(false);
            expect(result.matched === false && result.nameFailure?.reason).to.equal(expectedReason);
            expect(result.matched === false && result.nameFailure?.error).to.equal(thrown);
        });
    }

    it("reports a definitive no-record separately from a resolver failure", async () => {
        const { matcher } = buildMatcher({ name: ownerDomain, resolve: async () => null });

        const result = await matcher.matchesAnyIdentity([ownerDomain]);

        expect(result.matched).to.equal(false);
        expect(result.matched === false && result.nameFailure?.reason).to.equal(messages.ERR_AUTHOR_NAME_HAS_NO_RECORD);
    });

    it("never throws out of the matcher, however the resolver fails", async () => {
        const { matcher } = buildMatcher({
            name: ownerDomain,
            resolve: async () => {
                throw new Error("resolver exploded");
            }
        });

        // A challenge exclude must not be able to abort a whole publication because a name lookup failed.
        await expect(matcher.matchesAnyIdentity([ownerDomain])).resolves.toBeTruthy();
    });
});

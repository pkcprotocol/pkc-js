import { it, beforeAll, afterAll, expect } from "vitest";
import { v4 as uuidV4 } from "uuid";
import signers from "../../fixtures/signers.js";
import {
    createMockNameResolver,
    createSubWithNoChallenge,
    generateMockPost,
    mockPKCV2,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { timestamp } from "../../../dist/node/util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { NameResolver } from "../../../dist/node/types.js";

// These tests verify that the call sites which pass `cache: { maxAge: 0 }` to
// resolveAuthorNameIfNeeded actually bypass the persistent name-resolution
// cache and force a fresh resolver invocation. We use a tracking resolver that
// records every resolve() call for a given name; pre-warming the cache
// should not prevent a later cache-bypass call from invoking the resolver.

function createTrackingResolver(
    initialRecords: Record<string, string>,
    opts?: { key?: string; provider?: string }
): { resolver: NameResolver; calls: string[]; records: Map<string, string> } {
    const records = new Map<string, string>(Object.entries(initialRecords));
    const calls: string[] = [];
    const resolver = createMockNameResolver({
        key: opts?.key ?? "tracking-resolver",
        provider: opts?.provider ?? "mock://tracker",
        resolveFunction: async ({ name }) => {
            calls.push(name);
            const v = records.get(name);
            return v ? { publicKey: v } : undefined;
        }
    });
    return { resolver, calls, records };
}

describeSkipIfRpc("CommentModeration acceptance bypasses the name-resolution cache", () => {
    // Unique per run so the persistent cache at .pkc/lru-storage doesn't carry
    // a leftover entry from a previous test run (which would skip the resolver
    // call we want to count).
    const modDomain = `mod-cache-bypass-${uuidV4()}.bso`;
    const modSigner = signers[6];
    let pkc: PKC;
    let community: LocalCommunity;
    let calls: string[];

    beforeAll(async () => {
        const tracking = createTrackingResolver({ [modDomain]: modSigner.address });
        calls = tracking.calls;

        pkc = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            pkcOptions: { nameResolvers: [tracking.resolver] }
        });

        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });
        // Seed the mod's domain as the role key. Since issue #267 a domain role key is only ever
        // resolved when the publication's wire author.name is that key, so the resolver path we
        // want to count is reached only by the domain owner acting on its role.
        await community.edit({ roles: { [modDomain]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[modDomain]?.role === "moderator"
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("forces a fresh resolver call even when the cache has a fresh entry", async () => {
        // Pre-warm the cache: this writes (modDomain, modSigner.address) into the persistent cache.
        await pkc.resolveAuthorName({ name: modDomain });
        const callsForDomainAfterWarm = calls.filter((n) => n === modDomain).length;
        expect(callsForDomainAfterWarm).to.be.greaterThan(0);

        // Publish a comment as the (would-be) mod so we have a target CID.
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc,
            postProps: {
                author: { address: modDomain },
                signer: modSigner
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

        // Now publish a CommentModeration as the mod. `isPublicationAuthorPartOfRoles` must
        // re-resolve modDomain with `cache: { maxAge: 0 }` to bind the domain role key to the
        // signer, even though the persistent cache already holds a fresh entry.
        const banMod = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: post.cid,
            commentModeration: { author: { banExpiresAt: timestamp() + 300 }, reason: "cache-bypass test" },
            // author.address must be a domain so getAuthorNameFromWire returns it
            // and the role matcher enters the resolver path.
            author: { address: modDomain },
            signer: modSigner
        });
        await publishWithExpectedResult({ publication: banMod, expectedChallengeSuccess: true });

        const callsForDomainAfterMod = calls.filter((n) => n === modDomain).length;
        // The moderation flow goes through _checkPublicationValidity (uses 30m cache)
        // and then isPublicationAuthorPartOfRoles (uses maxAge=0). At minimum the
        // maxAge=0 call adds one more invocation regardless of cache state.
        expect(callsForDomainAfterMod).to.be.greaterThan(callsForDomainAfterWarm);
    });
});

describeSkipIfRpc("CommunityEdit role assignment bypasses the name-resolution cache", () => {
    const roleDomain = `role-cache-bypass-${uuidV4()}.bso`;
    const targetSigner = signers[2];
    let pkc: PKC;
    let community: LocalCommunity;
    let calls: string[];

    beforeAll(async () => {
        const tracking = createTrackingResolver({ [roleDomain]: targetSigner.address });
        calls = tracking.calls;

        pkc = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            pkcOptions: { nameResolvers: [tracking.resolver] }
        });

        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("re-resolves a role-domain on community.edit() even when cache is fresh", async () => {
        // Pre-warm the cache for the role domain.
        await pkc.resolveAuthorName({ name: roleDomain });
        const callsForDomainAfterWarm = calls.filter((n) => n === roleDomain).length;
        expect(callsForDomainAfterWarm).to.be.greaterThan(0);

        // Edit the community to add a moderator keyed by domain — this triggers
        // `_parseRolesToEdit` which passes `cache: { maxAge: 0 }`.
        await community.edit({ roles: { [roleDomain]: { role: "moderator" } } });
        expect(community.roles![roleDomain].role).to.equal("moderator");

        const callsForDomainAfterEdit = calls.filter((n) => n === roleDomain).length;
        expect(callsForDomainAfterEdit).to.be.greaterThan(callsForDomainAfterWarm);
    });
});

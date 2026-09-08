import { it, beforeAll, afterAll, expect, describe } from "vitest";
import { v4 as uuidV4 } from "uuid";
import signers from "../../fixtures/signers.js";
import {
    createMockNameResolver,
    generateMockPost,
    mockPKCV2,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { messages } from "../../../dist/node/errors.js";
import { timestamp } from "../../../dist/node/util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { CommunityEditOptions } from "../../../dist/node/community/types.js";
import type { NameResolver } from "../../../dist/node/types.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import type { DecryptedChallengeVerificationMessageType } from "../../../dist/node/pubsub-messages/types.js";

// Issue #267. `author.address` is `name || keyDerivedAddress`, built from the unresolved wire name. Before this
// fix every author-identity matcher on the community side (exclude.address, exclude.roles/roles, the blacklist and
// whitelist challenges) compared that string lexically, so with `resolveAuthorNames: false` any signer could set
// `author.name` to a domain it does not own and match an exclude or role keyed on that domain.
//
// Now an exclude says which identity it means: `publicKeys` is compared against the address derived from
// `signature.publicKey`, and `names` (like a domain role key or a domain in a blacklist/whitelist) is resolved at
// match time, regardless of `resolveAuthorNames`, and must resolve to the signer.

const ownerSigner = signers[6];
const impostorSigner = signers[7];

type Harness = {
    pkc: PKC;
    ownerDomain: string;
    resolverShouldThrow: { value: boolean };
    // Every name the community's resolver was actually asked for. Issue #354 turns on a key-derived role key
    // never costing a resolve, which is only observable by counting.
    resolvedNames: string[];
    communities: LocalCommunity[];
    createStartedCommunity: (edit: CommunityEditOptions) => Promise<LocalCommunity>;
};

async function createHarness(resolveAuthorNames: boolean): Promise<Harness> {
    // unique per run so the persistent resolver cache never carries a stale record across runs
    const ownerDomain = `owner-267-${uuidV4()}.bso`;
    const resolverShouldThrow = { value: false };
    const resolvedNames: string[] = [];
    const resolver: NameResolver = createMockNameResolver({
        key: `exclude-identity-resolver-${uuidV4()}`,
        resolveFunction: async ({ name }) => {
            resolvedNames.push(name);
            if (resolverShouldThrow.value) throw new Error("resolver is down");
            if (name === ownerDomain) return { publicKey: ownerSigner.address };
            return undefined;
        }
    });
    const pkc = await mockPKCV2({
        stubStorage: false,
        mockResolve: false,
        pkcOptions: { nameResolvers: [resolver], resolveAuthorNames }
    });
    const communities: LocalCommunity[] = [];
    const createStartedCommunity = async (edit: CommunityEditOptions) => {
        const community = (await pkc.createCommunity({})) as LocalCommunity;
        await community.edit(edit);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        communities.push(community);
        return community;
    };
    return { pkc, ownerDomain, resolverShouldThrow, resolvedNames, communities, createStartedCommunity };
}

async function destroyHarness(harness: Harness) {
    for (const community of harness.communities) await community.delete();
    await harness.pkc.destroy();
}

const publishPost = async (
    harness: Harness,
    community: LocalCommunity,
    opts: { signer: (typeof signers)[number]; name?: string; expectedChallengeSuccess: boolean; expectedReason?: string }
) => {
    const post = await generateMockPost({
        communityAddress: community.address,
        pkc: harness.pkc,
        postProps: {
            signer: opts.signer,
            ...(opts.name ? { author: { address: opts.name } } : {})
        }
    });
    await publishWithExpectedResult({
        publication: post,
        expectedChallengeSuccess: opts.expectedChallengeSuccess,
        expectedReason: opts.expectedReason
    });
    return post;
};

// Uses a LocalCommunity with a custom name resolver and resolveAuthorNames on the community owner's PKC,
// which under RPC lives on the server and cannot be configured per test.
for (const resolveAuthorNames of [false, true]) {
    describeSkipIfRpc(`exclude/role identity is bound to the signer (resolveAuthorNames: ${resolveAuthorNames})`, () => {
        let harness: Harness;

        beforeAll(async () => {
            harness = await createHarness(resolveAuthorNames);
        });

        afterAll(async () => {
            await destroyHarness(harness);
        });

        describe("exclude.names", () => {
            let community: LocalCommunity;
            beforeAll(async () => {
                community = await harness.createStartedCommunity({
                    settings: { challenges: [{ name: "fail", exclude: [{ names: [harness.ownerDomain] }] }] }
                });
            });

            it("matches the domain owner publishing under its name", async () => {
                await publishPost(harness, community, { signer: ownerSigner, name: harness.ownerDomain, expectedChallengeSuccess: true });
            });

            it("does not match an impostor claiming the domain", async () => {
                await publishPost(harness, community, {
                    signer: impostorSigner,
                    name: harness.ownerDomain,
                    expectedChallengeSuccess: false
                });
            });

            it("does not match the domain owner publishing without its name", async () => {
                await publishPost(harness, community, { signer: ownerSigner, expectedChallengeSuccess: false });
            });
        });

        describe("exclude.publicKeys", () => {
            let community: LocalCommunity;
            beforeAll(async () => {
                community = await harness.createStartedCommunity({
                    settings: { challenges: [{ name: "fail", exclude: [{ publicKeys: [ownerSigner.address] }] }] }
                });
            });

            it("matches the signer without a name", async () => {
                await publishPost(harness, community, { signer: ownerSigner, expectedChallengeSuccess: true });
            });

            it("matches the signer publishing under its domain name", async () => {
                await publishPost(harness, community, { signer: ownerSigner, name: harness.ownerDomain, expectedChallengeSuccess: true });
            });

            it("does not match another signer", async () => {
                await publishPost(harness, community, { signer: impostorSigner, expectedChallengeSuccess: false });
            });
        });

        describe("exclude.roles with a domain role key", () => {
            let community: LocalCommunity;
            beforeAll(async () => {
                community = await harness.createStartedCommunity({
                    roles: { [harness.ownerDomain]: { role: "moderator" } },
                    settings: { challenges: [{ name: "fail", exclude: [{ roles: ["moderator"] }] }] }
                });
            });

            it("matches the domain owner", async () => {
                await publishPost(harness, community, { signer: ownerSigner, name: harness.ownerDomain, expectedChallengeSuccess: true });
            });

            it("does not match an impostor claiming the domain", async () => {
                await publishPost(harness, community, {
                    signer: impostorSigner,
                    name: harness.ownerDomain,
                    expectedChallengeSuccess: false
                });
            });
        });

        describe("moderation authority with a domain role key", () => {
            let community: LocalCommunity;
            let post: CommentIpfsWithCidDefined;
            beforeAll(async () => {
                community = await harness.createStartedCommunity({
                    roles: { [harness.ownerDomain]: { role: "moderator" } },
                    settings: { challenges: [] }
                });
                post = (await publishRandomPost({ communityAddress: community.address, pkc: harness.pkc })) as CommentIpfsWithCidDefined;
            });

            it("rejects an impostor claiming the mod domain", async () => {
                const moderation = await harness.pkc.createCommentModeration({
                    communityAddress: community.address,
                    commentCid: post.cid,
                    commentModeration: { author: { banExpiresAt: timestamp() + 300 }, reason: "impostor" },
                    author: { address: harness.ownerDomain },
                    signer: impostorSigner
                });
                await publishWithExpectedResult({
                    publication: moderation,
                    expectedChallengeSuccess: false,
                    expectedReason: resolveAuthorNames
                        ? messages.ERR_AUTHOR_DOMAIN_RESOLVES_TO_DIFFERENT_SIGNER
                        : messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
                });
            });

            it("accepts the domain owner", async () => {
                const moderation = await harness.pkc.createCommentModeration({
                    communityAddress: community.address,
                    commentCid: post.cid,
                    commentModeration: { pinned: true },
                    author: { address: harness.ownerDomain },
                    signer: ownerSigner
                });
                await publishWithExpectedResult({ publication: moderation, expectedChallengeSuccess: true });
            });
        });
    });
}

describeSkipIfRpc("exclude/role identity: resolver-independent cases (resolveAuthorNames: false)", () => {
    let harness: Harness;

    beforeAll(async () => {
        harness = await createHarness(false);
    });

    afterAll(async () => {
        await destroyHarness(harness);
    });

    describe("whitelist challenge with a domain", () => {
        let community: LocalCommunity;
        beforeAll(async () => {
            community = await harness.createStartedCommunity({
                settings: { challenges: [{ name: "whitelist", options: { addresses: harness.ownerDomain } }] }
            });
        });

        it("passes the domain owner", async () => {
            await publishPost(harness, community, { signer: ownerSigner, name: harness.ownerDomain, expectedChallengeSuccess: true });
        });

        it("fails an impostor claiming the domain", async () => {
            await publishPost(harness, community, { signer: impostorSigner, name: harness.ownerDomain, expectedChallengeSuccess: false });
        });
    });

    describe("blacklist challenge with a domain", () => {
        let community: LocalCommunity;
        beforeAll(async () => {
            community = await harness.createStartedCommunity({
                settings: { challenges: [{ name: "blacklist", options: { addresses: harness.ownerDomain } }] }
            });
        });

        it("blocks the domain owner", async () => {
            await publishPost(harness, community, { signer: ownerSigner, name: harness.ownerDomain, expectedChallengeSuccess: false });
        });

        it("does not block a different signer that merely claims the domain", async () => {
            await publishPost(harness, community, { signer: impostorSigner, name: harness.ownerDomain, expectedChallengeSuccess: true });
        });
    });

    describe("resolver failure while checking a domain role key", () => {
        let community: LocalCommunity;
        let post: CommentIpfsWithCidDefined;
        beforeAll(async () => {
            community = await harness.createStartedCommunity({
                roles: { [harness.ownerDomain]: { role: "moderator" } },
                settings: { challenges: [] }
            });
            post = (await publishRandomPost({ communityAddress: community.address, pkc: harness.pkc })) as CommentIpfsWithCidDefined;
        });

        afterAll(() => {
            harness.resolverShouldThrow.value = false;
        });

        // Issue #353. Before this, the moderator was told they are not a moderator, which is what the check
        // concluded but not what happened: the community's node could not resolve names at all. Under RPC the
        // resolver lives on the server, so the debug line is not even on the machine the moderator is looking at.
        it("tells the moderator the community could not resolve the name, not that they are not a moderator", async () => {
            harness.resolverShouldThrow.value = true;
            const moderation = await harness.pkc.createCommentModeration({
                communityAddress: community.address,
                commentCid: post.cid,
                commentModeration: { pinned: true },
                author: { address: harness.ownerDomain },
                signer: ownerSigner
            });
            await publishWithExpectedResult({
                publication: moderation,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_FAILED_TO_RESOLVE_AUTHOR_NAME
            });
        });

        it("still says they are not a moderator when the resolver works and the name is not theirs", async () => {
            harness.resolverShouldThrow.value = false;
            const moderation = await harness.pkc.createCommentModeration({
                communityAddress: community.address,
                commentCid: post.cid,
                commentModeration: { pinned: true },
                author: { address: harness.ownerDomain },
                signer: impostorSigner
            });
            // The resolver answered and the domain is not theirs. Nothing is misconfigured, so the impostor
            // gets the plain rejection and learns nothing about the node.
            await publishWithExpectedResult({
                publication: moderation,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
            });
        });
    });

    // Issue #354. A moderator listed under both their public key and their domain must match on the key, which
    // is free, and never pay for the domain lookup. Nothing covered the ordering, so a refactor that resolved
    // eagerly would have passed every test while adding a resolver round trip to every moderator publication.
    // This runs with resolveAuthorNames false on purpose: with it on, checkAuthorIdentity resolves the wire
    // name for every publication that carries one before the matcher ever runs, and the count would say nothing
    // about the matcher.
    describe("a public-key role key short-circuits before any name resolution", () => {
        let community: LocalCommunity;
        beforeAll(async () => {
            community = await harness.createStartedCommunity({
                roles: {
                    [ownerSigner.address]: { role: "moderator" },
                    [harness.ownerDomain]: { role: "moderator" }
                },
                settings: {
                    challenges: [{ name: "fail", options: { error: "Only moderators can post here." }, exclude: [{ roles: ["moderator"] }] }]
                }
            });
        });

        afterAll(() => {
            harness.resolverShouldThrow.value = false;
        });

        it("excuses the moderator publishing under their domain without calling the resolver", async () => {
            const before = harness.resolvedNames.length;
            await publishPost(harness, community, { signer: ownerSigner, name: harness.ownerDomain, expectedChallengeSuccess: true });
            expect(harness.resolvedNames.slice(before)).to.deep.equal([]);
        });

        it("still excuses them while the resolver is down", async () => {
            harness.resolverShouldThrow.value = true;
            const before = harness.resolvedNames.length;
            // Authority comes from the key they signed with, so a resolver outage cannot take it away.
            await publishPost(harness, community, { signer: ownerSigner, name: harness.ownerDomain, expectedChallengeSuccess: true });
            expect(harness.resolvedNames.slice(before)).to.deep.equal([]);
        });
    });

    // Issue #353's decisive-only rule: the resolver failure becomes the reason only when it is what stood
    // between the author and being excused. A publisher who was going to be rejected anyway learns nothing.
    describe("a resolver failure that changed nothing stays quiet", () => {
        let community: LocalCommunity;
        beforeAll(async () => {
            community = await harness.createStartedCommunity({
                roles: { [harness.ownerDomain]: { role: "moderator" } },
                settings: {
                    challenges: [
                        {
                            name: "fail",
                            options: { error: "Only moderators can post here." },
                            // Two conditions. A stranger fails the karma one regardless of any name, so the
                            // unresolvable role key is not why they were refused.
                            exclude: [{ roles: ["moderator"], postScore: 100 }]
                        }
                    ]
                }
            });
        });

        afterAll(() => {
            harness.resolverShouldThrow.value = false;
        });

        it("leaves the reason unset so the publisher just sees the challenge's own error", async () => {
            harness.resolverShouldThrow.value = true;
            const post = await generateMockPost({
                communityAddress: community.address,
                pkc: harness.pkc,
                postProps: { signer: impostorSigner, author: { address: harness.ownerDomain } }
            });
            const verification = await new Promise<DecryptedChallengeVerificationMessageType>((resolve) => {
                post.once("challengeverification", resolve);
                post.publish();
            });
            expect(verification.challengeSuccess).to.equal(false);
            // The resolver was down and this publisher did claim the listed name, but the exclude also wanted
            // karma they do not have, so the name was never what stood in their way.
            expect(verification.reason).to.be.undefined;
            expect(verification.challengeErrors?.[0]).to.equal("Only moderators can post here.");
        });
    });
});

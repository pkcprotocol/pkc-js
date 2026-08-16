// An author community (issue #31) is an ordinary community addressed by the author's identity key,
// configured so only its owner can post, whose feed is the owner's crossposts. See
// docs/protocol/author-communities.md.
//
// The point of this file is that none of that needs new machinery: the delegated community comes from
// #237, owner-only posting is the built-in `fail` challenge paired with an `exclude`, and the feed is
// ordinary comments carrying `comment.crosspost` from #32. If any of those seams stop composing, these
// tests fail even though nothing named "author community" exists in src/.
//
// Naming follows docs/protocol/delegated-ipns.md: An/As = anchor keypair (the author's identity, held
// by the owner), Mn/Ms = minter keypair (held by the node).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
    createMockNameResolver,
    createSubWithNoChallenge,
    generateMockComment,
    generateMockPost,
    mockPKC,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { createAnchorIpnsRecord } from "../../../dist/node/signer/index.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import type { CommunityChallengeSetting } from "../../../dist/node/community/types.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { DecryptedChallengeVerificationMessageType } from "../../../dist/node/pubsub-messages/types.js";

const OWNER_DOMAIN = "author-community-owner.bso";
const OWNER_ONLY_ERROR = "Only the owner can post to this profile.";

// The two excludes that express "the owner posts, anyone may reply". An exclude array matches if ANY
// item matches, and an item matches only if ALL of its conditions hold, so the `fail` challenge runs
// for exactly one case: a non-owner publishing a post.
function ownerOnlyPostingChallenge(): CommunityChallengeSetting {
    return {
        name: "fail",
        options: { error: OWNER_ONLY_ERROR },
        exclude: [
            { role: ["owner"] },
            { publicationType: { reply: true, vote: true, commentEdit: true, commentModeration: true, communityEdit: true } }
        ]
    };
}

// A `fail` challenge reports through challengeErrors, not through the verification `reason`, so
// publishWithExpectedResult's expectedReason cannot see it.
async function publishAndCaptureVerification(publication: Comment): Promise<DecryptedChallengeVerificationMessageType> {
    const verification = new Promise<DecryptedChallengeVerificationMessageType>((resolve, reject) => {
        publication.once("challengeverification", resolve);
        publication.once("error", reject);
    });
    await publication.publish();
    return verification;
}

// Skipped under RPC: the community runs on the RPC server, which has its own PKC and therefore not the
// mock name resolver constructed here, so checkAuthorIdentity on the server cannot resolve the owner's
// domain and the domain-keyed role case would fail for an unrelated reason. The RPC dimension of
// delegation setup is covered by test/node/community/delegation-setup.test.ts.
describeSkipIfRpc.sequential("author community: a community configured as a profile", () => {
    let pkc: PKC;
    let anchorSigner: SignerType; // As stays in the test; the node never receives it
    let community: LocalCommunity;
    let minterAddress: string;
    const resolverRecords = new Map<string, string>();

    beforeAll(async () => {
        pkc = await mockPKC({ nameResolvers: [createMockNameResolver({ records: resolverRecords })] });
        anchorSigner = await pkc.createSigner();
        resolverRecords.set(OWNER_DOMAIN, anchorSigner.address);

        community = <LocalCommunity>await createSubWithNoChallenge({ anchor: { publicKey: anchorSigner.address } }, pkc);
        minterAddress = community.signer.address;

        // Both roles keys, because exclude.role matches community.roles[author.address] and
        // author.address is `name || publicKey`. See "The roles key" in the protocol doc.
        await community.edit({
            roles: { [anchorSigner.address]: { role: "owner" }, [OWNER_DOMAIN]: { role: "owner" } },
            settings: { ...community.settings, challenges: [ownerOnlyPostingChallenge()] }
        });

        // A delegated community refuses to start until its anchor record is published (#234). The first
        // record is signed at sequence 0, since there is no prior sequence to discover.
        await community.publishAnchorRecord(await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterAddress, sequence: 0 }));
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    describe("identity is the author's key", () => {
        it("is addressed by the anchor, not by the minter that signs its record", () => {
            expect(community.address).to.equal(anchorSigner.address);
            expect(community.publicKey).to.equal(anchorSigner.address);
            expect(minterAddress).to.not.equal(anchorSigner.address);
        });

        it("publishes the signed anchor claim, so a reader can recover the identity", () => {
            expect(community.raw.communityIpfs!.anchor).to.deep.equal({ publicKey: anchorSigner.address });
            expect(community.raw.communityIpfs!.signature.signedPropertyNames).to.include("anchor");
        });
    });

    describe("only the owner may post", () => {
        it("accepts the owner's post, matched on the peer-id roles key", async () => {
            const post = await generateMockPost({ communityAddress: community.address, pkc, postProps: { signer: anchorSigner } });
            await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        });

        // author.address becomes the domain once author.name is set, so this exercises the other roles
        // key. checkAuthorIdentity resolves the domain and compares it against the signer first.
        it("accepts the owner's post when they publish under their domain, matched on the domain roles key", async () => {
            const post = await generateMockPost({
                communityAddress: community.address,
                pkc,
                postProps: { signer: anchorSigner, author: { name: OWNER_DOMAIN } }
            });
            await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        });

        it("rejects a stranger's post with the configured error", async () => {
            const post = await generateMockPost({ communityAddress: community.address, pkc });
            const verification = await publishAndCaptureVerification(post);
            expect(verification.challengeSuccess).to.be.false;
            expect(verification.challengeErrors?.["0"]).to.equal(OWNER_ONLY_ERROR);
        });

        // The second exclude is what keeps the profile reply-able: only posts are owner-only.
        it("accepts a stranger's reply", async () => {
            const ownerPost = await publishRandomPost({
                communityAddress: community.address,
                pkc,
                postProps: { signer: anchorSigner }
            });
            const reply = await generateMockComment(ownerPost as CommentIpfsWithCidDefined, pkc, false);
            await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
        });
    });

    // This is the assertion the whole design rests on. Owner-only posting has no feature flag and no
    // read-side check, so a client can only know a community is a profile by reading the exclude rules
    // off the record. If exclude ever stops being copied into the public challenges array, the
    // restriction becomes invisible and nothing else in the suite would catch it.
    describe("the restriction is legible on the wire", () => {
        it("publishes the exclude rules verbatim in the signed record", () => {
            const published = community.raw.communityIpfs!.challenges;
            expect(published).to.have.lengthOf(1);
            expect(published[0].exclude).to.deep.equal(ownerOnlyPostingChallenge().exclude);
        });

        it("publishes the roles map, which is what exclude.role is matched against", () => {
            expect(community.raw.communityIpfs!.roles).to.deep.equal({
                [anchorSigner.address]: { role: "owner" },
                [OWNER_DOMAIN]: { role: "owner" }
            });
        });

        it("strips the private half of the challenge settings", () => {
            const published = community.raw.communityIpfs!.challenges[0];
            expect(published).to.not.have.property("name");
            expect(published).to.not.have.property("path");
            // options carries the error text and, for other challenges, the answer
            expect(published).to.not.have.property("options");
        });
    });

    describe("the feed is the owner's crossposts", () => {
        let originCommunity: LocalCommunity;
        let crosspostingPost: Comment;

        beforeAll(async () => {
            originCommunity = <LocalCommunity>await createSubWithNoChallenge({}, pkc);
            await originCommunity.start();
            await resolveWhenConditionIsTrue({
                toUpdate: originCommunity,
                predicate: async () => typeof originCommunity.updatedAt === "number"
            });
        });

        afterAll(async () => {
            await originCommunity.delete();
        });

        it("accepts a crosspost of the owner's comment in another community", async () => {
            const original = await publishRandomPost({
                communityAddress: originCommunity.address,
                pkc,
                postProps: { signer: anchorSigner }
            });
            crosspostingPost = await generateMockPost({
                communityAddress: community.address,
                pkc,
                postProps: { signer: anchorSigner, crosspost: { cid: original.cid!, comment: original.raw.comment! } }
            });
            await publishWithExpectedResult({ publication: crosspostingPost, expectedChallengeSuccess: true });
            expect(crosspostingPost.cid).to.be.a("string");
        });

        // The community verifies its own record, pages included, before publishing it
        // (_validateCommunitySizeSchemaAndSignatureBeforePublishing -> verifyCommunity -> verifyPage), so
        // a feed of crossposts reaching the wire at all is the shared page verifier accepting it with no
        // author-community special casing.
        it("carries the crosspost into the published feed, through the shared page verifier", async () => {
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () =>
                    Object.values(community.posts.pages).some((page) =>
                        page?.comments.some((pageComment) => pageComment.cid === crosspostingPost.cid)
                    )
            });

            const pageComment = Object.values(community.posts.pages)
                .flatMap((page) => page?.comments ?? [])
                .find((comment) => comment.cid === crosspostingPost.cid);
            expect(pageComment).to.not.be.undefined;
            expect(pageComment!.crosspost?.cid).to.equal(crosspostingPost.raw.comment!.crosspost!.cid);
        });
    });
});

// The failure mode the protocol doc warns about: the excludes are configured, the roles map exists, but
// it is keyed on a form the owner does not publish under. Everything looks correct until the first post.
describeSkipIfRpc.sequential("author community: a roles map keyed on the wrong form locks the owner out", () => {
    let pkc: PKC;
    let anchorSigner: SignerType;
    let community: LocalCommunity;
    const resolverRecords = new Map<string, string>();

    beforeAll(async () => {
        pkc = await mockPKC({ nameResolvers: [createMockNameResolver({ records: resolverRecords })] });
        anchorSigner = await pkc.createSigner();
        resolverRecords.set(OWNER_DOMAIN, anchorSigner.address);

        community = <LocalCommunity>await createSubWithNoChallenge({ anchor: { publicKey: anchorSigner.address } }, pkc);
        // Only the peer-id key. exclude.role does a bare map lookup with no name resolution, unlike
        // isPublicationAuthorPartOfRoles, so publishing under a domain misses this entirely.
        await community.edit({
            roles: { [anchorSigner.address]: { role: "owner" } },
            settings: { ...community.settings, challenges: [ownerOnlyPostingChallenge()] }
        });
        await community.publishAnchorRecord(
            await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: community.signer.address, sequence: 0 })
        );
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("rejects the owner's own post when they publish under a domain the roles map does not carry", async () => {
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc,
            postProps: { signer: anchorSigner, author: { name: OWNER_DOMAIN } }
        });
        const verification = await publishAndCaptureVerification(post);
        expect(verification.challengeSuccess).to.be.false;
        expect(verification.challengeErrors?.["0"]).to.equal(OWNER_ONLY_ERROR);
    });

    it("accepts the same owner publishing without a name, which matches the peer-id key", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc, postProps: { signer: anchorSigner } });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });
});

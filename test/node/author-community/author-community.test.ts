// An author community (issue #31) is an ordinary community addressed by the author's identity key,
// configured so only its owner can post, whose feed is the owner's crossposts. See
// docs/protocol/author-communities.md.
//
// The point of this file is that none of that needs new machinery: the delegated community comes from
// #237, owner-only posting is settings.disablePubsubChallengeExchange (#229) backed by the built-in
// `fail` challenge paired with an `exclude`, and the feed is ordinary comments carrying
// `comment.crosspost` from #32. If any of those seams stop composing, these tests fail even though
// nothing named "author community" exists in src/.
//
// These run under RPC too. The owner's role is matched against a domain in one case, and name
// resolution happens wherever the community lives, so under RPC this file stands up its own RPC server
// with the mock resolver on the SERVER pkc. Pointing at the shared test server instead would leave the
// server unable to resolve a domain minted in this process, which would look like a role mismatch.
//
// Naming follows docs/protocol/delegated-ipns.md: An/As = anchor keypair (the author's identity, held
// by the owner), Mn/Ms = minter keypair (held by the node).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import PKC from "../../../dist/node/index.js";
import {
    createMockNameResolver,
    createSubWithNoChallenge,
    generateMockComment,
    generateMockPost,
    generateMockVote,
    isRpcFlagOn,
    mockPKC,
    mockRpcServerForTests,
    mockRpcServerPKC,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { createAnchorIpnsRecord, createSigner } from "../../../dist/node/signer/index.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type Vote from "../../../dist/node/publications/vote/vote.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import type { CommunityChallengeSetting } from "../../../dist/node/community/types.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { DecryptedChallengeVerificationMessageType } from "../../../dist/node/pubsub-messages/types.js";
import { createInProcessRpcServer, uniqueTmpDataPath } from "../../helpers/rpc-server-harness.js";

type ProfileCommunity = LocalCommunity | RpcLocalCommunity;

const OWNER_DOMAIN = "author-community-owner.bso";
// A second domain rather than re-pointing the first: checkAuthorIdentity resolves with a 30 minute
// cache, so a domain that has already resolved once in this process keeps its old address and the
// publication would be rejected for a signer mismatch instead of by the challenge under test.
const OTHER_OWNER_DOMAIN = "author-community-other-owner.bso";
const OWNER_ONLY_ERROR = "Only the owner can post to this profile.";
const RPC_AUTH_KEY = "test-author-community";

// The resolver reads this map at resolve time, so entries can be added after the pkc is built. Under
// RPC the server pkc is in this same process, so it shares the map by reference.
const resolverRecords = new Map<string, string>();

// A pkc whose community-hosting side can resolve OWNER_DOMAIN, under either config.
async function createHarness(): Promise<{ pkc: PKCType; teardown: () => Promise<void> }> {
    const nameResolvers = [createMockNameResolver({ records: resolverRecords, includeDefaultRecords: true })];
    if (!isRpcFlagOn()) {
        const pkc = await mockPKC({ nameResolvers });
        return { pkc, teardown: async () => await pkc.destroy() };
    }

    // A fresh dataPath per run. This suite creates communities on the server, so a fixed path would
    // accumulate them across runs, and any run that dies before afterAll leaves a started community
    // behind for the next server to resume at startup, which eventually times out the beforeAll hook.
    // The mock resolver goes on the server pkc here, since the shared harness injects the pkc as-is.
    const dataPath = uniqueTmpDataPath("pkc-rpc-author-community");
    const serverPKC = await mockRpcServerPKC({ dataPath, nameResolvers });
    const { rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY });
    // The harness only binds and injects; publishing over RPC still needs the test relaxations.
    mockRpcServerForTests(rpcServer);

    const pkc = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
    return {
        pkc,
        teardown: async () => {
            await pkc.destroy();
            await rpcServer.destroy(); // also destroys the injected serverPKC
            fs.rmSync(dataPath, { recursive: true, force: true });
        }
    };
}

// The default (feed-only) config's challenge: `fail` excluding the owner alone, backing up
// settings.disablePubsubChallengeExchange. The setting removes the remote publishing path, but the
// challenge pipeline still runs on the local/RPC shortcut, so this is what rejects everyone but the
// owner on the one path that remains.
function ownerOnlyChallenge(): CommunityChallengeSetting {
    return {
        name: "fail",
        options: { error: OWNER_ONLY_ERROR },
        // Options are private by default. Naming `error` here publishes that one value, so a reader sees
        // the rejection text without publishing anything. It is a hint, not proof: see the wire test below.
        publicOptions: ["error"],
        exclude: [{ roles: ["owner"] }]
    };
}

// The reply-able flavor keeps the exchange on and narrows the `fail` challenge instead. An exclude
// array matches if ANY item matches, and an item matches only if ALL of its conditions hold, so the
// challenge runs for exactly two cases: a non-owner publishing a post, and a non-owner publishing a
// vote. `vote` is deliberately absent from the publicationType exclude: profile karma is read from
// each entry's origin community at tier 2, so a vote on the copy would be tallied by the owner's own
// delegate and count toward nothing. See "Votes stay rejected" in the protocol doc.
function replyAbleChallenge(): CommunityChallengeSetting {
    return {
        ...ownerOnlyChallenge(),
        exclude: [
            { roles: ["owner"] },
            { publicationType: { reply: true, commentEdit: true, commentModeration: true, communityEdit: true } }
        ]
    };
}

// A `fail` challenge reports through challengeErrors, not through the verification `reason`, so
// publishWithExpectedResult's expectedReason cannot see it.
async function publishAndCaptureVerification(publication: Comment | Vote): Promise<DecryptedChallengeVerificationMessageType> {
    const verification = new Promise<DecryptedChallengeVerificationMessageType>((resolve, reject) => {
        publication.once("challengeverification", resolve);
        publication.once("error", reject);
    });
    await publication.publish();
    return verification;
}

// A delegated community refuses to start until its anchor record is published (#234). The first record
// is signed at sequence 0, since there is no prior sequence to discover.
async function startProfile(community: ProfileCommunity, anchorSigner: SignerType) {
    await community.publishAnchorRecord(
        await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: community.signer.address, sequence: 0 })
    );
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
}

describe.sequential("author community: a community configured as a profile", () => {
    let pkc: PKCType;
    let teardown: () => Promise<void>;
    let anchorSigner: SignerType; // As is generated wherever the owner is, never on the node
    let community: ProfileCommunity;
    let minterAddress: string;

    beforeAll(async () => {
        ({ pkc, teardown } = await createHarness());
        anchorSigner = await createSigner();
        resolverRecords.set(OWNER_DOMAIN, anchorSigner.address);

        community = await createSubWithNoChallenge({ anchor: { publicKey: anchorSigner.address } }, pkc);
        minterAddress = community.signer.address;

        // The default feed-only config from the protocol doc: the exchange is disabled, so every
        // publish in this suite goes through the local/RPC shortcut, where the challenge pipeline
        // still runs. Both roles keys: each is bound to the signer by its own rule, and the suite
        // exercises both. See "The roles key" in the protocol doc.
        await community.edit({
            roles: { [anchorSigner.address]: { role: "owner" }, [OWNER_DOMAIN]: { role: "owner" } },
            settings: { ...community.settings, disablePubsubChallengeExchange: true, challenges: [ownerOnlyChallenge()] }
        });
        await startProfile(community, anchorSigner);
    });

    afterAll(async () => {
        await community.delete();
        await teardown();
    });

    describe("identity is the author's key", () => {
        // Guards the harness rather than the feature. Under RPC the community has to live on the server
        // this file stood up, or the suite would quietly be re-running the non-RPC path and the domain
        // case would prove nothing about resolution happening where the community is.
        it("exercises the configuration under test", () => {
            expect(Boolean(pkc._pkcRpcClient)).to.equal(isRpcFlagOn());
        });

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

        // With both keys in the map the peer-id key still matches first and no name is resolved, so
        // this only proves the domain form does not break the owner. The domain-only block below is
        // what exercises the domain key's own rule.
        it("accepts the owner's post when they publish under their domain", async () => {
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

        // The role exclude is the only exclude, so the feed-only default is owner-only for every
        // publication type, replies included. Replying is the reply-able flavor's opt-in, below.
        it("rejects a stranger's reply with the same error", async () => {
            const ownerPost = await publishRandomPost({
                communityAddress: community.address,
                pkc,
                postProps: { signer: anchorSigner }
            });
            const reply = await generateMockComment(ownerPost as CommentIpfsWithCidDefined, pkc, false);
            const verification = await publishAndCaptureVerification(reply);
            expect(verification.challengeSuccess).to.be.false;
            expect(verification.challengeErrors?.["0"]).to.equal(OWNER_ONLY_ERROR);
        });
    });

    // Votes stay rejected: under the default config a stranger's vote hits the `fail` challenge
    // exactly like a stranger's post, while the owner stays excluded by role. See "Votes stay
    // rejected" in the protocol doc for why a vote on a profile copy counts toward nothing.
    describe("votes are rejected by default", () => {
        let ownerPost: Comment;

        beforeAll(async () => {
            ownerPost = await publishRandomPost({
                communityAddress: community.address,
                pkc,
                postProps: { signer: anchorSigner }
            });
        });

        it("rejects a stranger's vote with the configured error", async () => {
            const vote = await generateMockVote(ownerPost as CommentIpfsWithCidDefined, 1, pkc);
            const verification = await publishAndCaptureVerification(vote);
            expect(verification.challengeSuccess).to.be.false;
            expect(verification.challengeErrors?.["0"]).to.equal(OWNER_ONLY_ERROR);
        });

        it("accepts the owner's vote, matched on the role exclude", async () => {
            const vote = await generateMockVote(ownerPost as CommentIpfsWithCidDefined, 1, pkc, anchorSigner);
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
        });
    });

    // The reply-able opt-in: the exchange stays on and the publicationType exclude is what keeps
    // replies open while posts and votes stay owner-only. See "The reply-able flavor" in the doc.
    describe("the reply-able flavor", () => {
        let replyAbleCommunity: ProfileCommunity;
        let replyAbleAnchor: SignerType;
        let ownerPost: Comment;

        beforeAll(async () => {
            replyAbleAnchor = await createSigner();
            replyAbleCommunity = await createSubWithNoChallenge({ anchor: { publicKey: replyAbleAnchor.address } }, pkc);
            await replyAbleCommunity.edit({
                roles: { [replyAbleAnchor.address]: { role: "owner" } },
                settings: { ...replyAbleCommunity.settings, challenges: [replyAbleChallenge()] }
            });
            await startProfile(replyAbleCommunity, replyAbleAnchor);
            ownerPost = await publishRandomPost({
                communityAddress: replyAbleCommunity.address,
                pkc,
                postProps: { signer: replyAbleAnchor }
            });
        });

        afterAll(async () => {
            await replyAbleCommunity.delete();
        });

        it("carries a pubsubTopic, since the exchange stays enabled", () => {
            expect(replyAbleCommunity.raw.communityIpfs!.pubsubTopic).to.be.a("string");
        });

        // The second exclude is what keeps this flavor reply-able: only posts and votes are owner-only.
        it("accepts a stranger's reply", async () => {
            const reply = await generateMockComment(ownerPost as CommentIpfsWithCidDefined, pkc, false);
            await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
        });

        it("rejects a stranger's post with the configured error", async () => {
            const post = await generateMockPost({ communityAddress: replyAbleCommunity.address, pkc });
            const verification = await publishAndCaptureVerification(post);
            expect(verification.challengeSuccess).to.be.false;
            expect(verification.challengeErrors?.["0"]).to.equal(OWNER_ONLY_ERROR);
        });

        it("still rejects a stranger's vote", async () => {
            const vote = await generateMockVote(ownerPost as CommentIpfsWithCidDefined, 1, pkc);
            const verification = await publishAndCaptureVerification(vote);
            expect(verification.challengeSuccess).to.be.false;
            expect(verification.challengeErrors?.["0"]).to.equal(OWNER_ONLY_ERROR);
        });
    });

    // This is the assertion the whole design rests on. Owner-only posting has no feature flag and no
    // read-side check, so a client can only know a community is a profile by reading the exclude rules
    // off the record. If exclude ever stops being copied into the public challenges array, the
    // restriction becomes invisible and nothing else in the suite would catch it.
    describe("the restriction is legible on the wire", () => {
        // The feed-only default's strongest signal: a record with no pubsubTopic tells a reader the
        // exchange is off, so no publisher can even open one. See "What a reader can actually tell".
        it("publishes no pubsubTopic, which is what tells a reader the exchange is disabled", () => {
            expect(community.raw.communityIpfs!.pubsubTopic).to.be.undefined;
            expect("pubsubTopic" in community.raw.communityIpfs!).to.be.false;
        });

        it("publishes the exclude rules verbatim in the signed record", () => {
            const published = community.raw.communityIpfs!.challenges;
            expect(published).to.have.lengthOf(1);
            expect(published[0].exclude).to.deep.equal(ownerOnlyChallenge().exclude);
        });

        it("publishes the roles map, which is what exclude.roles is matched against", () => {
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

        // Only what the owner named in publicOptions crosses the boundary, and it crosses as a separate
        // field. A profile publishing its rejection text is the whole reason this config sets it.
        it("publishes only the option the owner opted into, under publicOptions", () => {
            const published = community.raw.communityIpfs!.challenges[0];
            expect(published.publicOptions).to.deep.equal({ error: OWNER_ONLY_ERROR });
        });
    });

    // The record declares itself a profile through suggested.uiType, set through the same edit() as the
    // rest of the configuration. It is a rendering hint clients may ignore, spoofable like `title`, and
    // nothing in pkc-js branches on it. See "Declaring the profile to UIs" in the protocol doc.
    describe("declaring the profile to UIs", () => {
        it("edit({ suggested: { uiType } }) lands in the published signed record", async () => {
            expect(community.raw.communityIpfs!.suggested?.uiType).to.be.undefined;
            await community.edit({ suggested: { uiType: "author" } });
            // edit() patches raw.communityIpfs from internal state immediately, old signature and all,
            // so the record carrying the hint is not proof it was re-signed. Wait for the signature that
            // covers it: signedPropertyNames lists only the fields present at signing time.
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => community.raw.communityIpfs?.signature.signedPropertyNames.includes("suggested") === true
            });
            expect(community.raw.communityIpfs!.suggested?.uiType).to.equal("author");
        });

        it("exposes the hint on the community instance", () => {
            expect(community.suggested?.uiType).to.equal("author");
        });
    });

    describe("the feed is the owner's crossposts", () => {
        let originCommunity: ProfileCommunity;
        let crosspostingPost: Comment;

        beforeAll(async () => {
            originCommunity = await createSubWithNoChallenge({}, pkc);
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

    // The one lock-out left after #267: the excludes are configured and the roles map exists, but it
    // carries only the owner's domain, and the domain key matches only when the owner publishes under
    // that exact name and it resolves to the signer. Everything looks correct until the first post
    // sent without author.name. This block is also what proves the challenge is genuinely wired up,
    // since it is the one owner rejection that has to happen for the acceptance tests above to mean
    // anything.
    describe("a roles map keyed on the domain alone", () => {
        let domainOnlyCommunity: ProfileCommunity;
        let otherAnchor: SignerType;

        beforeAll(async () => {
            otherAnchor = await createSigner();
            resolverRecords.set(OTHER_OWNER_DOMAIN, otherAnchor.address);

            domainOnlyCommunity = await createSubWithNoChallenge({ anchor: { publicKey: otherAnchor.address } }, pkc);
            await domainOnlyCommunity.edit({
                roles: { [OTHER_OWNER_DOMAIN]: { role: "owner" } },
                settings: { ...domainOnlyCommunity.settings, challenges: [ownerOnlyChallenge()] }
            });
            await startProfile(domainOnlyCommunity, otherAnchor);
        });

        afterAll(async () => {
            await domainOnlyCommunity.delete();
        });

        it("rejects the owner's own post when they publish without the name the roles map carries", async () => {
            const post = await generateMockPost({
                communityAddress: domainOnlyCommunity.address,
                pkc,
                postProps: { signer: otherAnchor }
            });
            const verification = await publishAndCaptureVerification(post);
            expect(verification.challengeSuccess).to.be.false;
            expect(verification.challengeErrors?.["0"]).to.equal(OWNER_ONLY_ERROR);
        });

        it("accepts the same owner publishing under the domain, which resolves to the signer", async () => {
            const post = await generateMockPost({
                communityAddress: domainOnlyCommunity.address,
                pkc,
                postProps: { signer: otherAnchor, author: { name: OTHER_OWNER_DOMAIN } }
            });
            await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        });

        // Rejected either by the author identity check or by the challenge, depending on where the
        // signer mismatch is caught first; only the outcome matters here, so the reason is not pinned.
        it("rejects an impostor claiming the domain, since the name must resolve to the signer", async () => {
            const post = await generateMockPost({
                communityAddress: domainOnlyCommunity.address,
                pkc,
                postProps: { author: { name: OTHER_OWNER_DOMAIN } }
            });
            const verification = await publishAndCaptureVerification(post);
            expect(verification.challengeSuccess).to.be.false;
        });
    });
});

// A delegated LocalCommunity (issue #233): the anchor An is the community identity, the minter Mn is
// the signing key that lives on the node. See docs/protocol/delegated-ipns.md. Kind-blind: nothing
// here is author-community specific.
//
// Naming: An/As = anchor keypair (identity, owner-held), Mn/Ms = minter keypair (node-held, rotatable).
// Setup over RPC lives in test/node/community/delegation-setup.test.ts (issue #234).
//
// The cases left as it.todo below need the anchor record on the network (rotation, read-back through
// the chain, import/export of a live delegated community), which is #234's publishAnchorRecord.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import Logger from "@pkcprotocol/pkc-logger";
import {
    createSubWithNoChallenge,
    disableValidationOfSignatureBeforePublishing,
    ensurePublicationIsSigned,
    mockPKC,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { messages } from "../../../../dist/node/errors.js";
import { _signJson, cleanUpBeforePublishing } from "../../../../dist/node/signer/signatures.js";
import { getPKCAddressFromPublicKey } from "../../../../dist/node/signer/util.js";
import { createAnchorIpnsRecord } from "../../../../dist/node/signer/index.js";
import { ipnsNameToIpnsOverPubsubTopic, pubsubTopicToDhtKey } from "../../../../dist/node/util.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type Publication from "../../../../dist/node/publications/publication.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";

type PublicationWithSigner = Publication & { signer?: SignerType };

// Skipped under RPC: these assertions read the community's own DB rows, its data directory and its
// in-process instance internals (ipnsName, signer.ipnsKeyName), none of which an RPC client can see.
// The RPC surface of delegation is covered by test/node/rpc/delegation-setup.rpc.test.ts.
describeSkipIfRpc.sequential("delegated LocalCommunity: identity is the anchor, signing is the minter", () => {
    let pkc: PKC;
    let anchorSigner: SignerType; // As stays here in the test only; the node never receives it
    let community: LocalCommunity;
    let minterAddress: string;

    beforeAll(async () => {
        pkc = await mockPKC();
        anchorSigner = await pkc.createSigner();
        community = <LocalCommunity>await createSubWithNoChallenge({ anchor: { publicKey: anchorSigner.address } }, pkc);
        minterAddress = community.signer.address;
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    describe("anchor as persisted local state", () => {
        it("keys the community by the anchor and generates its own minter", () => {
            expect(community.anchor).to.deep.equal({ publicKey: anchorSigner.address });
            expect(community.address).to.equal(anchorSigner.address);
            expect(minterAddress).to.not.equal(anchorSigner.address);
        });

        it("sets ipnsHops to [anchor, signer.address] at init", () => {
            expect(community.ipnsHops).to.deep.equal([anchorSigner.address, minterAddress]);
        });

        it("replays the anchor into ipnsHops on load, so identity survives a reload from db", async () => {
            const reloaded = <LocalCommunity>await pkc.createCommunity({ address: community.address });
            expect(reloaded.anchor).to.deep.equal({ publicKey: anchorSigner.address });
            expect(reloaded.ipnsHops).to.deep.equal([anchorSigner.address, minterAddress]);
            expect(reloaded.publicKey).to.equal(anchorSigner.address);
            expect(reloaded.signer.address).to.equal(minterAddress);
        });

        it("rejects an empty anchor publicKey", async () => {
            await expect(pkc.createCommunity({ anchor: { publicKey: "" } })).rejects.toThrow();
        });

        it("rejects passing both a signer and an anchor", async () => {
            await expect(
                pkc.createCommunity({ signer: await pkc.createSigner(), anchor: { publicKey: anchorSigner.address } })
            ).rejects.toThrow(messages.ERR_CAN_NOT_CREATE_A_COMMUNITY_WITH_BOTH_SIGNER_AND_ANCHOR);
        });
    });

    describe("identity reports the anchor, not the signer", () => {
        it("community.publicKey is the anchor", () => {
            expect(community.publicKey).to.equal(anchorSigner.address);
        });

        it("community.signer.address stays the minter", () => {
            expect(community.signer.address).to.equal(minterAddress);
            expect(community.signer.address).to.not.equal(community.publicKey);
        });

        it("the community data directory is keyed by the anchor, matching what readers resolve", () => {
            expect(fs.existsSync(path.join(pkc.dataPath!, "communities", anchorSigner.address))).to.be.true;
            expect(fs.existsSync(path.join(pkc.dataPath!, "communities", minterAddress))).to.be.false;
        });

        it("pkc.communities lists the anchor address", async () => {
            expect(pkc.communities).to.include(anchorSigner.address);
            expect(pkc.communities).to.not.include(minterAddress);
        });
    });

    // Only identity moves to the anchor. Everything the minter key produces stays minter-derived.
    describe("minter-derived state stays minter-derived", () => {
        it("encryption.publicKey is the minter's public key", async () => {
            expect(community.encryption.publicKey).to.equal(community.signer.publicKey);
            expect(await getPKCAddressFromPublicKey(community.encryption.publicKey)).to.equal(minterAddress);
        });

        it("signer.ipnsKeyName is the minter, so kubo publishes under Mn", () => {
            expect(community.signer.ipnsKeyName).to.equal(minterAddress);
        });

        it("the backfilled pubsubTopic is the minter address", () => {
            expect(community.pubsubTopic).to.equal(minterAddress);
        });

        it("ipnsName stays the minter on a publisher, and does NOT follow ipnsHops[0]", () => {
            expect(community.ipnsHops?.[0]).to.equal(anchorSigner.address);
            expect(community.ipnsName).to.equal(minterAddress);
        });

        it("ipnsPubsubTopic and ipnsPubsubTopicRoutingCid stay derived from the minter", () => {
            const minterTopic = ipnsNameToIpnsOverPubsubTopic(minterAddress);
            expect(community.ipnsPubsubTopic).to.equal(minterTopic);
            expect(community.ipnsPubsubTopicRoutingCid).to.equal(pubsubTopicToDhtKey(minterTopic));
            expect(community.ipnsPubsubTopic).to.not.equal(ipnsNameToIpnsOverPubsubTopic(anchorSigner.address));
        });
    });

    describe("a non-delegated community is the degenerate case", () => {
        it("identity is unchanged and ipnsHops is absent when no anchor is set", async () => {
            const plain = <LocalCommunity>await createSubWithNoChallenge({}, pkc);
            try {
                expect(plain.anchor).to.be.undefined;
                expect(plain.ipnsHops).to.be.undefined;
                expect(plain.publicKey).to.equal(plain.signer.address);
                expect(plain.address).to.equal(plain.signer.address);
                expect(plain.ipnsName).to.equal(plain.signer.address);
                expect(plain.pubsubTopic).to.equal(plain.signer.address);
            } finally {
                await plain.delete();
            }
        });
    });

    describe("a started delegated community", () => {
        let post: Comment;

        beforeAll(async () => {
            // A delegated community refuses to start until its anchor record is published (#234), so the
            // owner signs the An -> Mn binding here. Holding As in the test is what a real owner does on
            // their own machine; the community never sees it. Setup itself is covered by
            // test/node/community/delegation-setup.test.ts.
            await community.publishAnchorRecord(
                await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterAddress, sequence: 0 })
            );
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        });

        it("publishes a record signed by the minter, and never puts the anchor on the wire", async () => {
            const record = community.raw.communityIpfs!;
            expect(await getPKCAddressFromPublicKey(record.signature.publicKey)).to.equal(minterAddress);
            expect(record).to.not.have.property("anchor");
            expect(record).to.not.have.property("ipnsHops");
        });

        // A publisher sets communityPublicKey from the address it resolved, which is the anchor. Before
        // #233 this was compared against signer.address, so every remote publication was rejected.
        it("accepts a publication whose communityPublicKey is the anchor", async () => {
            post = await publishRandomPost({ communityAddress: community.address, pkc });
            expect(post.cid).to.be.a("string");
            expect(post.communityPublicKey).to.equal(anchorSigner.address);
        });

        it("labels stored content with the anchor, so it survives a minter rotation", async () => {
            const row = community._dbHandler.queryComment(post.cid!);
            expect(row?.communityPublicKey).to.equal(anchorSigner.address);
        });

        it("rejects a publication whose communityPublicKey is the minter", async () => {
            const comment = await pkc.createComment({
                communityAddress: community.address,
                title: `Minter-addressed comment ${Date.now()}`,
                content: `Content ${Date.now()}`,
                signer: await pkc.createSigner()
            });
            await injectCommunityPublicKey(comment, minterAddress);
            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
            });
        });

        it("rejects a publication whose communityPublicKey is an unrelated key", async () => {
            const unrelated = await pkc.createSigner();
            const comment = await pkc.createComment({
                communityAddress: community.address,
                title: `Unrelated-key comment ${Date.now()}`,
                content: `Content ${Date.now()}`,
                signer: await pkc.createSigner()
            });
            await injectCommunityPublicKey(comment, unrelated.address);
            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
            });
        });

        // No per-type special case: the acceptance check is shared, so a second publication type is
        // enough to show the anchor comparison is not comment-specific.
        it("accepts a vote addressed to the anchor and rejects one addressed to the minter", async () => {
            const accepted = await pkc.createVote({
                commentCid: post.cid!,
                vote: 1,
                communityAddress: community.address,
                signer: await pkc.createSigner()
            });
            await publishWithExpectedResult({ publication: accepted, expectedChallengeSuccess: true });

            const rejected = await pkc.createVote({
                commentCid: post.cid!,
                vote: 1,
                communityAddress: community.address,
                signer: await pkc.createSigner()
            });
            await injectCommunityPublicKey(rejected, minterAddress);
            await publishWithExpectedResult({
                publication: rejected,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY
            });
        });

        // _communityChallengeMsgSignerAddress derives the expected signer from encryption.publicKey
        // (#236), which is the minter. Nothing else on master exercises it with signer != anchor.
        it("completes the challenge exchange against a community whose signer is not its identity", async () => {
            const commentEdit = await pkc.createCommentEdit({
                commentCid: post.cid!,
                content: `Edited ${Date.now()}`,
                communityAddress: community.address,
                signer: post.signer!
            });
            await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });
            const editRow = community._dbHandler.queryComment(post.cid!);
            expect(editRow?.communityPublicKey).to.equal(anchorSigner.address);
        });
    });

    // --- helpers ---

    async function injectCommunityPublicKey(publication: PublicationWithSigner, communityPublicKey: string) {
        const log = Logger("pkc-js:test:injectCommunityPublicKey");
        if (!publication.signer) throw Error("Expected publication to have a signer");
        await ensurePublicationIsSigned(publication, community);

        const orig = publication.raw.pubsubMessageToPublish!;
        const modified = { ...orig, communityPublicKey } as Record<string, unknown>;
        modified.signature = await _signJson(
            orig.signature.signedPropertyNames,
            cleanUpBeforePublishing(modified),
            publication.signer,
            log
        );
        publication.raw.pubsubMessageToPublish = modified as typeof orig;
        publication.signature = modified.signature as typeof publication.signature;
        disableValidationOfSignatureBeforePublishing(publication);
    }
});

describe("delegated community setup that needs the anchor record on the network (#234)", () => {
    it.todo("a RemoteCommunity resolving the chain reports the anchor as its identity");
    it.todo("comments published to the delegated community load with the anchor as communityPublicKey");
    it.todo("the community address is unchanged after rotating to a new minter");
    it.todo("previously stored content still resolves and verifies after a rotation");
    it.todo("the pubsubTopic changes with the minter, and a reader that re-resolves picks it up");
    it.todo("exportCommunity carries the anchor");
    it.todo("importing an exported delegated community restores identity without the anchor's private key");
});

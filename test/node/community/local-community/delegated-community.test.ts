// A delegated LocalCommunity (issue #233): the anchor An is the community identity, the minter Mn is
// the signing key that lives on the node. See docs/protocol/delegated-ipns.md. Kind-blind: nothing
// here is author-community specific.
//
// Naming: An/As = anchor keypair (identity, owner-held), Mn/Ms = minter keypair (node-held, rotatable).
// Setup over RPC lives in test/node/community/delegation-setup.test.ts (issue #234).
//
// The later blocks (read-back through the chain, rotation, export/import) need the anchor record on the
// network, so they use #234's publishAnchorRecord to put it there.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import Logger from "@pkcprotocol/pkc-logger";
import {
    createMockNameResolver,
    createSubWithNoChallenge,
    disableValidationOfSignatureBeforePublishing,
    ensurePublicationIsSigned,
    mockPKC,
    mockRemotePKC,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { messages } from "../../../../dist/node/errors.js";
import { _signJson, cleanUpBeforePublishing } from "../../../../dist/node/signer/signatures.js";
import { getPKCAddressFromPublicKey } from "../../../../dist/node/signer/util.js";
import { createAnchorIpnsRecord } from "../../../../dist/node/signer/index.js";
import { getPersistedAnchorRecordBytes } from "../../../../dist/node/runtime/node/community/local-community/anchor-publishing.js";
import { unmarshalIPNSRecord } from "ipns";
import { ipnsNameToIpnsOverPubsubTopic, pubsubTopicToDhtKey } from "../../../../dist/node/util.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type Publication from "../../../../dist/node/publications/publication.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";
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
    let post: Comment; // published to the delegated community by the started-community block below

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

        // anchor.publicKey becomes the community's address, so an unvalidated value would only fail much
        // later, inside peerIdFromString during publishAnchorRecord, on a community already keyed by it.
        it("rejects an anchor publicKey that is not an IPNS name", async () => {
            await expect(pkc.createCommunity({ anchor: { publicKey: "not-an-ipns-name" } })).rejects.toThrow(
                messages.ERR_ANCHOR_PUBLIC_KEY_IS_INVALID
            );
            // The base64 raw-key representation signer.publicKey uses, which is NOT what an anchor takes.
            await expect(pkc.createCommunity({ anchor: { publicKey: anchorSigner.publicKey } })).rejects.toThrow(
                messages.ERR_ANCHOR_PUBLIC_KEY_IS_INVALID
            );
        });

        it("rejects passing both a signer and an anchor", async () => {
            await expect(
                pkc.createCommunity({ signer: await pkc.createSigner(), anchor: { publicKey: anchorSigner.address } })
            ).rejects.toThrow(messages.ERR_CAN_NOT_CREATE_A_COMMUNITY_WITH_BOTH_SIGNER_AND_ANCHOR);
        });

        // A delegated community is keyed by its anchor, so an identifier passed alongside would be
        // silently dropped rather than applied.
        it("rejects passing an identifier alongside an anchor", async () => {
            const otherAnchor = await pkc.createSigner();
            for (const identifier of [{ name: "some-community.bso" }, { address: otherAnchor.address }, { publicKey: otherAnchor.address }])
                await expect(pkc.createCommunity({ ...identifier, anchor: { publicKey: anchorSigner.address } })).rejects.toThrow(
                    messages.ERR_CAN_NOT_CREATE_A_COMMUNITY_WITH_BOTH_ANCHOR_AND_IDENTIFIER
                );
        });

        // An anchor is the owner's key, but the minter still has to live on a node with a dataPath, so a
        // browser holding As cannot create the community itself: it asks a node over RPC. Without this
        // guard the call falls through to _createRemoteCommunityInstance and hands back a RemoteCommunity
        // for an address nothing publishes yet, which reads as success and only fails much later, on an
        // update that never arrives. The signer path shares the guard and had no coverage either.
        it("refuses to create a delegated community where no local community can exist", async () => {
            const browserLikePkc = await mockRemotePKC();
            try {
                await expect(browserLikePkc.createCommunity({ anchor: { publicKey: anchorSigner.address } })).rejects.toThrow(
                    messages.ERR_CAN_NOT_CREATE_A_LOCAL_COMMUNITY
                );
                await expect(browserLikePkc.createCommunity({ signer: await browserLikePkc.createSigner() })).rejects.toThrow(
                    messages.ERR_CAN_NOT_CREATE_A_LOCAL_COMMUNITY
                );
            } finally {
                await browserLikePkc.destroy();
            }
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
        beforeAll(async () => {
            // A delegated community refuses to start until its anchor record is published (#234), so the
            // owner signs the An -> Mn binding here. Holding As in the test is what a real owner does on
            // their own machine; the community never sees it. Setup itself is covered by
            // test/node/community/delegation-setup.test.ts.
            await community.publishAnchorRecord(await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterAddress, sequence: 0 }));
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

        // Accepting a publication and being able to PUBLISH it are two different things, and every
        // assertion above stops at acceptance. A community's record only carries content once a sync
        // cycle has written postUpdates and posts into it, and that record is validated against itself
        // before it goes out. A plain community reaches this state in well under a second.
        it("publishes a record that carries the post it accepted", async () => {
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline && !community.postUpdates) await new Promise((resolve) => setTimeout(resolve, 500));

            expect(community.postUpdates, "the community must publish postUpdates once it has content").to.be.an("object");
            expect(Object.keys(community.postUpdates!).length).to.be.greaterThan(0);
            expect(community.posts?.pages?.hot?.comments.some((pageComment) => pageComment.cid === post.cid)).to.be.true;
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

    // The read side (#93) is already implemented and tested against fixtures. What is new here is that
    // the chain a real reader walks was produced by a pkc-js node rather than by a hand-built fixture,
    // so this is the round trip closing: what we publish is what the resolver expects.
    describe("reading back what a delegated community publishes", () => {
        let readerPkc: PKC;
        let loaded: RemoteCommunity;

        beforeAll(async () => {
            // No dataPath, so this instance cannot hold the community locally and has to resolve it.
            readerPkc = await mockRemotePKC();
            loaded = <RemoteCommunity>await readerPkc.createCommunity({ address: anchorSigner.address });
            await loaded.update();
            await resolveWhenConditionIsTrue({ toUpdate: loaded, predicate: async () => typeof loaded.updatedAt === "number" });
            await loaded.stop();
        });

        afterAll(async () => {
            await readerPkc.destroy();
        });

        it("a RemoteCommunity resolving the chain reports the anchor as its identity", () => {
            expect(loaded.publicKey).to.equal(anchorSigner.address);
            expect(loaded.address).to.equal(anchorSigner.address);
            expect(loaded.ipnsHops).to.deep.equal([anchorSigner.address, minterAddress]);
        });

        it("the record verifies with content signed by the minter", async () => {
            expect(await getPKCAddressFromPublicKey(loaded.signature!.publicKey)).to.equal(minterAddress);
            expect(loaded.signature!.publicKey).to.not.equal(loaded.publicKey);
        });

        it("comments published to the delegated community load with the anchor as communityPublicKey", async () => {
            const { content } = await readerPkc.fetchCid({ cid: post.cid! });
            const commentIpfs = JSON.parse(content) as { communityPublicKey?: string; communityName?: string };
            expect(commentIpfs.communityPublicKey).to.equal(anchorSigner.address);
            expect(commentIpfs.communityPublicKey).to.not.equal(minterAddress);
        });

        // fetchCid above reads the raw block and checks a field. A reader loading the same comment goes
        // through verification, which compares the wire communityPublicKey against the community's
        // publicKey (the anchor), and then resolves the community from that same value, walking An -> Mn
        // before it can even find the CommentUpdate. Nothing else covers that whole path against a
        // community whose record signer is not its identity, and the CommentUpdate is signed by the
        // minter while the comment names the anchor, which is exactly where a check against the wrong
        // key would surface.
        it("a reader loads the post and its CommentUpdate, verifying through the chain", async () => {
            // Its own instance, not readerPkc: the block above already resolved this community's record
            // through readerPkc, and a second community instance in a pkc that has loaded that CID takes
            // the "no need to fetch its ipfs" path, so it never hands the comment a community record to
            // read postUpdates from. That is a reader-cache behaviour with nothing to do with
            // delegation, and sitting on it would only mean testing the cache.
            const commentReaderPkc = await mockRemotePKC();
            const loadedPost = await commentReaderPkc.createComment({ cid: post.cid! });
            try {
                await loadedPost.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: loadedPost,
                    predicate: async () => typeof loadedPost.updatedAt === "number"
                });
                expect(loadedPost.communityPublicKey).to.equal(anchorSigner.address);
                expect(loadedPost.communityPublicKey).to.not.equal(minterAddress);
                expect(loadedPost.content).to.equal(post.content);
                expect(loadedPost.author.address).to.equal(post.author.address);
            } finally {
                await loadedPost.stop();
                await commentReaderPkc.destroy();
            }
        });
    });

    // Rotation is the same act as the first publish against a different node: create there, sign
    // An -> Mn', publish. The old minter keeps its key but nothing points at it.
    describe("minter rotation", () => {
        let rotationPkc: PKC;
        let rotationDataPath: string;
        let rotated: LocalCommunity;
        let newMinterAddress: string;
        let readerAfterRotation: PKC;

        beforeAll(async () => {
            // The old minter stands down FIRST. Two started LocalCommunity instances in one process
            // that share a publicKey collide in the process-wide started-community registry, which is
            // keyed by publicKey and knows nothing about dataPath: the second instance would load the
            // first one's state and then fail its own signature validation. Stopping first is also what
            // a real rotation does, and on real hardware the two nodes are separate processes anyway.
            await community.stop();

            rotationDataPath = path.join(process.cwd(), ".tmp", `delegated-rotation-${uuidv4()}`);
            rotationPkc = await mockPKC({ dataPath: rotationDataPath });
            rotated = <LocalCommunity>await rotationPkc.createCommunity({ anchor: { publicKey: anchorSigner.address } });
            await rotated.edit({ settings: { challenges: [] } });
            newMinterAddress = rotated.signer.address;

            // This node has never accepted an anchor record, so it learns the current sequence from the
            // network rather than restarting at 0.
            const prepared = await rotated.prepareAnchorPublish();
            expect(prepared.hasPersistedAnchorRecord).to.be.false;
            await rotated.publishAnchorRecord(
                await createAnchorIpnsRecord({
                    anchorSigner,
                    minterIpnsName: newMinterAddress,
                    sequence: BigInt(prepared.nextSequence)
                })
            );
        });
        // Starting the rotated community is deliberately NOT in the hook above: the first publish of a
        // minter whose name has never resolved blocks for a minute inside
        // resolveIpnsAndLogIfPotentialProblematicSequence, a diagnostic-only resolve with a 120s
        // timeout, and a hook carrying that plus the rest blew the 160s hook budget.

        afterAll(async () => {
            await readerAfterRotation?.destroy();
            await rotated.delete();
            await rotationPkc.destroy();
            fs.rmSync(rotationDataPath, { recursive: true, force: true });
        });

        it("the community address is unchanged after rotating to a new minter", () => {
            expect(newMinterAddress).to.not.equal(minterAddress);
            expect(rotated.address).to.equal(anchorSigner.address);
            expect(rotated.publicKey).to.equal(anchorSigner.address);
            expect(rotated.ipnsHops).to.deep.equal([anchorSigner.address, newMinterAddress]);
        });

        it("previously stored content still resolves and verifies, with no rewrite", async () => {
            const { content } = await rotationPkc.fetchCid({ cid: post.cid! });
            const commentIpfs = JSON.parse(content) as { communityPublicKey?: string };
            // Labelled with the anchor when the OLD minter stored it, and still naming the community's
            // identity now. Had it been labelled with signer.address it would name a key that no longer
            // publishes this community.
            expect(commentIpfs.communityPublicKey).to.equal(anchorSigner.address);
            expect(commentIpfs.communityPublicKey).to.equal(rotated.publicKey);
        });

        it("the pubsubTopic changes with the minter, and a reader that re-resolves picks it up", async () => {
            expect(rotated.pubsubTopic).to.equal(newMinterAddress);
            expect(rotated.pubsubTopic).to.not.equal(minterAddress);

            await rotated.start();
            await resolveWhenConditionIsTrue({ toUpdate: rotated, predicate: async () => typeof rotated.updatedAt === "number" });

            readerAfterRotation = await mockRemotePKC();
            const reloaded = <RemoteCommunity>await readerAfterRotation.createCommunity({ address: anchorSigner.address });
            await reloaded.update();
            // kubo caches IPNS resolutions briefly, so the reader may see the old binding for a moment.
            // This is exactly the "re-resolve before publishing rather than trusting a cached topic"
            // obligation documented for client authors.
            await resolveWhenConditionIsTrue({
                toUpdate: reloaded,
                predicate: async () => reloaded.ipnsHops?.[1] === newMinterAddress
            });
            await reloaded.stop();

            expect(reloaded.publicKey).to.equal(anchorSigner.address);
            expect(reloaded.pubsubTopic).to.equal(newMinterAddress);
            expect(await getPKCAddressFromPublicKey(reloaded.signature!.publicKey)).to.equal(newMinterAddress);
        });
    });

    describe("export and import", () => {
        let exportedDbPath: string;
        let importPkc: PKC;
        let importDataPath: string;
        let importedWithOpenDb: LocalCommunity | undefined;

        afterAll(async () => {
            // The imported community below is never started, so pkc.destroy() (which only tears down
            // started/updating communities) leaves its db connection open, and Windows refuses to unlink
            // an open sqlite file.
            importedWithOpenDb?._dbHandler?.destoryConnection();
            await importPkc?.destroy();
            if (importDataPath) fs.rmSync(importDataPath, { recursive: true, force: true });
        });

        it("exportCommunity carries the anchor", async () => {
            const { exportId } = await community.export({ includePrivateKey: true });
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => community.exports.some((record) => record.exportId === exportId && record.progress === 1),
                eventName: "exportschange"
            });
            const record = community.exports.find((r) => r.exportId === exportId)!;
            expect(record.error).to.be.undefined;
            // The export is keyed by the community's identity, which is the anchor, so a rotation does
            // not orphan backups taken under the old minter.
            expect(record.publicKey).to.equal(anchorSigner.address);
            exportedDbPath = fileURLToPath(record.url!);
            expect(fs.existsSync(exportedDbPath)).to.be.true;
        });

        it("importing an exported delegated community restores identity without the anchor's private key", async () => {
            // Import is a file move: drop the exported db where a pkc instance looks for the community.
            importDataPath = path.join(process.cwd(), ".tmp", `delegated-import-${uuidv4()}`);
            fs.mkdirSync(path.join(importDataPath, "communities"), { recursive: true });
            fs.copyFileSync(exportedDbPath, path.join(importDataPath, "communities", anchorSigner.address));

            importPkc = await mockPKC({ dataPath: importDataPath });
            const imported = <LocalCommunity>await importPkc.createCommunity({ address: anchorSigner.address });

            expect(imported.anchor).to.deep.equal({ publicKey: anchorSigner.address });
            expect(imported.publicKey).to.equal(anchorSigner.address);
            expect(imported.signer.address).to.equal(minterAddress);
            expect(imported.ipnsHops).to.deep.equal([anchorSigner.address, minterAddress]);

            // The anchor travels as a public key only. An operator restoring this backup can publish the
            // community, and still cannot re-point the anchor at a minter of their own.
            const exportedDbBytes = fs.readFileSync(exportedDbPath).toString("binary");
            expect(exportedDbBytes).to.not.include(anchorSigner.privateKey);
            expect(imported.signer.privateKey).to.not.equal(anchorSigner.privateKey);
        });

        // Identity alone is not enough to run the restored community: a delegated community refuses to
        // start without its anchor record, and the owner holding As may be long gone by the time a
        // backup is restored. So the record and its high-water mark have to be inside the backup, and
        // nothing above would notice if the export had carried the identity but left them behind.
        //
        // Asserted on the restored state rather than by starting it: the rotated community above is
        // started in this process under the same anchor publicKey, and the started-community registry
        // is keyed by publicKey, so a second started instance of the same identity would collide.
        it("carries the anchor record itself, so the restored community is startable", async () => {
            const imported = <LocalCommunity>await importPkc.createCommunity({ address: anchorSigner.address });
            importedWithOpenDb = imported; // afterAll closes it, see the note there
            // The instance closes its db connection after loading, and the anchor record lives in keyv,
            // which is what start() and publishAnchorRecord open it for.
            await imported._dbHandler.initDbIfNeeded();

            const recordBytes = getPersistedAnchorRecordBytes(imported);
            expect(recordBytes, "the exported db must carry the record start() refuses to run without").to.be.instanceOf(Uint8Array);
            expect(recordBytes!.length).to.be.greaterThan(0);

            const record = unmarshalIPNSRecord(recordBytes!);
            expect(record.value, "and it must still bind the anchor to this community's minter").to.equal(`/ipns/${minterAddress}`);
            expect(record.sequence).to.equal(0n);
            // The high-water mark travels in its own slot, and a restore that lost it would accept a
            // replay of the record above as if it were new.
            expect(imported.anchorRecordSequence).to.equal("0");
        });
    });

    // The domain checks are what the signer.address audit turned up: a domain's TXT record points at the
    // name readers resolve, which on a delegated community is the anchor and never the minter. Compared
    // against signer.address, a correctly configured delegated community would have rejected its own
    // domain on every start and every edit. Both directions are asserted, since a check that accepts
    // everything would pass the happy path alone.
    describe("a delegated community addressed by a domain", () => {
        const anchorDomain = "delegated-publisher-anchor.bso";
        const minterDomain = "delegated-publisher-minter.bso";
        const resolverRecords = new Map<string, string>(); // filled once the keys below exist
        let domainPkc: PKC;
        let domainDataPath: string;
        let domainCommunity: LocalCommunity;

        beforeAll(async () => {
            domainDataPath = path.join(process.cwd(), ".tmp", `delegated-domain-${uuidv4()}`);
            domainPkc = await mockPKC({ dataPath: domainDataPath, nameResolvers: [createMockNameResolver({ records: resolverRecords })] });
            const domainAnchor = await domainPkc.createSigner();
            domainCommunity = <LocalCommunity>await createSubWithNoChallenge({ anchor: { publicKey: domainAnchor.address } }, domainPkc);
            resolverRecords.set(anchorDomain, domainAnchor.address); // what a reader following the domain gets
            resolverRecords.set(minterDomain, domainCommunity.signer.address); // pointed at the rotatable key instead
        });

        afterAll(async () => {
            await domainCommunity.delete();
            await domainPkc.destroy();
            fs.rmSync(domainDataPath, { recursive: true, force: true });
        });

        it("accepts a domain whose TXT record resolves to the anchor", async () => {
            await domainCommunity._assertDomainResolvesCorrectly(anchorDomain);
            await domainCommunity.edit({ address: anchorDomain });
            expect(domainCommunity.address).to.equal(anchorDomain);
        });

        // A domain pointing at the minter leads readers to a key that stops publishing the moment the
        // owner rotates, so it is wrong even though it names a key this node holds.
        it("rejects a domain resolving to the minter", async () => {
            await expect(domainCommunity._assertDomainResolvesCorrectly(minterDomain)).rejects.toThrow(
                messages.ERR_DOMAIN_COMMUNITY_ADDRESS_TXT_RECORD_POINT_TO_DIFFERENT_ADDRESS
            );

            // edit() does not await the check: validateNewAddressBeforeEditing fires it and routes the
            // failure to the error event, so the address moves and the owner is told separately. That is
            // pre-existing behaviour, not delegation-specific, so this asserts what an owner observes
            // rather than the rejection the check alone would suggest.
            const emittedError = new Promise<Error>((resolve) => domainCommunity.once("error", resolve));
            await domainCommunity.edit({ address: minterDomain });
            expect((await emittedError).message).to.include(messages.ERR_DOMAIN_COMMUNITY_ADDRESS_TXT_RECORD_POINT_TO_DIFFERENT_ADDRESS);
        });
    });
});

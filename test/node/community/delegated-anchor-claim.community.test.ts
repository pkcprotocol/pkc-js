// End-to-end proof of the anchor claim (#257): a reader who reaches a delegated community through a
// domain whose TXT record points at the MINTER re-anchors to the identity declared by the record's
// signed anchor claim, publishes an anchor-labelled publication that the community ACCEPTS, and then
// verifies the community's pages (whose comments are labelled with the anchor) through the claim.
//
// Naming: An/As = anchor keypair (identity, owner-held), Mn/Ms = minter keypair (node-held).
// The owner's resolver maps the domain to the anchor (a correctly configured TXT from the owner's
// point of view, required for the community to start with a domain name); the reader's resolver maps
// the same domain to the minter (the misconfigured/stale TXT under test).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
    createMockNameResolver,
    createSubWithNoChallenge,
    mockPKC,
    mockRemotePKC,
    publishRandomPost,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { createAnchorIpnsRecord, createSigner } from "../../../dist/node/signer/index.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

const DOMAIN = "delegated-claim-e2e.bso";

// Skipped under RPC: the reader's name resolver is mocked on the client, which is impossible over an
// RPC client (resolution happens server-side), and the owner-side assertions read LocalCommunity
// internals the RPC surface does not expose.
describeSkipIfRpc.sequential("anchor claim end-to-end: reader behind a minter-pointing TXT (#257)", () => {
    let ownerPkc: PKC;
    let readerPkc: PKC;
    let anchorSigner: SignerType; // As, held by the owner only
    let community: LocalCommunity;
    let minterAddress: string;
    let reader: RemoteCommunity;
    let post: Comment;

    beforeAll(async () => {
        // As is generated wherever the owner is (a pure client-side Ed25519 generator); only its
        // address string reaches the node below.
        anchorSigner = await createSigner();
        ownerPkc = await mockPKC(
            { nameResolvers: [createMockNameResolver({ records: { [DOMAIN]: anchorSigner.address } })] },
            false,
            true,
            false
        );
        community = <LocalCommunity>await createSubWithNoChallenge({ anchor: { publicKey: anchorSigner.address }, name: DOMAIN }, ownerPkc);
        minterAddress = community.signer.address;
        // First publish: the owner signs sequence 0 locally; As never reaches the node.
        await community.publishAnchorRecord(await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterAddress, sequence: 0 }));
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        readerPkc = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: { nameResolvers: [createMockNameResolver({ records: { [DOMAIN]: minterAddress } })] }
        });
    });

    afterAll(async () => {
        if (reader) await reader.stop().catch((): undefined => undefined);
        if (community) await community.delete().catch((): undefined => undefined);
        if (readerPkc) await readerPkc.destroy();
        if (ownerPkc) await ownerPkc.destroy();
    });

    it("the minted record carries the signed anchor claim", () => {
        expect(community.raw.communityIpfs?.anchor).to.deep.equal({ publicKey: anchorSigner.address });
        expect(community.raw.communityIpfs?.signature.signedPropertyNames).to.include("anchor");
    });

    it("the reader re-anchors to the claim and reports nameResolved false", async () => {
        reader = (await readerPkc.createCommunity({ address: DOMAIN })) as RemoteCommunity;
        const migrationErrors: PKCError[] = [];
        reader.on("error", (err) => {
            if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") migrationErrors.push(err as PKCError);
        });
        await reader.update();
        await resolveWhenConditionIsTrue({ toUpdate: reader, predicate: async () => reader.nameResolved === false });
        expect(reader.updatedAt).to.be.a("number");
        expect(reader.address).to.equal(DOMAIN);
        expect(reader.publicKey).to.equal(anchorSigner.address); // the claim, not the TXT's minter
        expect(reader.anchor?.publicKey).to.equal(anchorSigner.address);
        expect(reader.nameResolved).to.be.false;
        // no identity expectation existed before the record loaded, so no migration was involved
        expect(migrationErrors).to.deep.equal([]);
    });

    it("the reader publishes organically and the community accepts an anchor-labelled publication", async () => {
        // Pre-#257 this reader would have labelled the publication with the minter (its identity at
        // the time) and been rejected with ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY.
        post = await publishRandomPost({ communityAddress: DOMAIN, pkc: readerPkc });
        expect(post.cid).to.be.a("string");
        expect(post.communityPublicKey).to.equal(anchorSigner.address);
    });

    it("the community's pages carry anchor-labelled comments that verify through the claim", async () => {
        // The record that carries the accepted post is validated by the reader on arrival: an update
        // WITH pages arriving at all proves verifyCommunity passed with the claim; the labels are
        // asserted explicitly on top.
        await resolveWhenConditionIsTrue({
            toUpdate: reader,
            predicate: async () => Boolean(reader.posts?.pages?.hot?.comments.some((pageComment) => pageComment.cid === post.cid))
        });
        const labels = new Set(reader.raw.communityIpfs!.posts!.pages!.hot!.comments.map((c) => c.comment.communityPublicKey));
        expect([...labels]).to.deep.equal([anchorSigner.address]);
    });
});

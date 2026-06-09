// Tests for community.exportCommunityModLogs() — issue #89.
// The matrix block runs under whichever pkc-config the runner selected: local-kubo-rpc (embedded
// LocalCommunity) and, under USE_RPC=1, remote-pkc-rpc (RpcLocalCommunity -> server -> LocalCommunity).
// The DB-connection lifecycle block is embedded-only because it inspects the LocalCommunity's
// internal better-sqlite3 handle, which the RPC client does not expose.
import {
    createSubWithNoChallenge,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    mockPKC,
    getAvailablePKCConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { SignerWithPublicKeyAddress } from "../../../dist/node/signer/index.js";

type AnyLocalCommunity = LocalCommunity | RpcLocalCommunity;

// Reaches into the LocalCommunity's better-sqlite3 handle. destoryConnection() sets _db to undefined,
// so an absent handle (or a closed one) reads as "not open".
function isDbOpen(community: LocalCommunity): boolean {
    const dbHandler = (community as unknown as { _dbHandler?: { _db?: { open?: boolean } } })._dbHandler;
    return dbHandler?._db?.open === true;
}

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`community.exportCommunityModLogs() — ${config.name}`, () => {
        let pkc: PKC;
        let community: AnyLocalCommunity;
        let moderatorSigner: SignerWithPublicKeyAddress;
        let postCid: string;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            community = (await createSubWithNoChallenge({}, pkc)) as AnyLocalCommunity;
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

            moderatorSigner = await pkc.createSigner();
            await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
            });

            const post = await publishRandomPost({ communityAddress: community.address, pkc });
            postCid = post.cid!;

            const modPublication = await pkc.createCommentModeration({
                communityAddress: community.address,
                commentCid: postCid,
                commentModeration: { removed: true, reason: "test mod log" },
                signer: moderatorSigner
            });
            await publishWithExpectedResult({ publication: modPublication, expectedChallengeSuccess: true });
        });

        afterAll(async () => {
            await community.stop();
            await pkc.destroy();
        });

        it("returns the published moderation with JSON columns parsed", async () => {
            const { moderations } = await community.exportCommunityModLogs({ commentCid: postCid });
            expect(moderations.length).to.be.greaterThan(0);
            const mod = moderations.find((m) => m.commentCid === postCid);
            expect(mod, "moderation targeting the post should be returned").to.exist;
            expect(mod!.commentModeration.removed).to.equal(true);
            expect(mod!.commentModeration.reason).to.equal("test mod log");
            // commentModeration and signature must come back as objects, not JSON strings.
            expect(mod!.commentModeration).to.be.an("object");
            expect(mod!.signature).to.be.an("object");
            expect(mod!.signature).to.not.be.a("string");
            expect(mod!.modSignerAddress).to.equal(moderatorSigner.address);
        });

        it("honors the commentCid, timestamp window and limit filters", async () => {
            const filtered = await community.exportCommunityModLogs({ commentCid: postCid });
            expect(filtered.moderations.length).to.be.greaterThan(0);
            filtered.moderations.forEach((m) => expect(m.commentCid).to.equal(postCid));

            // A window ending before any moderation existed returns nothing.
            const none = await community.exportCommunityModLogs({ endTimestamp: 1 });
            expect(none.moderations).to.deep.equal([]);

            const limited = await community.exportCommunityModLogs({ limit: 1 });
            expect(limited.moderations.length).to.equal(1);
        });
    });
});

// Embedded-only: inspects the LocalCommunity's internal better-sqlite3 handle, which the RPC
// client does not expose. Verifies exportCommunityModLogs works on a stopped community and does
// not leak a DB connection on a non-running community.
describeSkipIfRpc("community.exportCommunityModLogs() DB connection lifecycle (embedded)", () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let moderatorSigner: SignerWithPublicKeyAddress;
    let postCid: string;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        moderatorSigner = await pkc.createSigner();
        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
        });

        const post = await publishRandomPost({ communityAddress: community.address, pkc });
        postCid = post.cid!;

        const modPublication = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: postCid,
            commentModeration: { removed: true, reason: "lifecycle mod log" },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: modPublication, expectedChallengeSuccess: true });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it.sequential("keeps the DB connection open when exporting on a started community", async () => {
        expect(community.state).to.equal("started");
        const { moderations } = await community.exportCommunityModLogs({ commentCid: postCid });
        expect(moderations.length).to.be.greaterThan(0);
        // The running community's update/publish loop relies on this connection; it must stay open.
        expect(isDbOpen(community)).to.equal(true);
    });

    it.sequential("exports mod logs after stop(), then closes the connection it opened", async () => {
        await community.stop();
        expect(community.state).to.equal("stopped");
        // stop() closed the DB connection; exportCommunityModLogs must transparently re-open it to read.
        const { moderations } = await community.exportCommunityModLogs({ commentCid: postCid });
        const mod = moderations.find((m) => m.commentCid === postCid);
        expect(mod, "moderation should still be readable after stop()").to.exist;
        expect(mod!.commentModeration.removed).to.equal(true);
        // No DB handle should be left open on a stopped community.
        expect(isDbOpen(community)).to.equal(false);
    });
});

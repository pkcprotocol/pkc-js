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
    mockPKCNoDataPathWithOnlyKuboClient,
    mockRpcRemotePKC,
    getAvailablePKCConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc, itSkipIfRpc, itIfRpc } from "../../helpers/conditional-tests.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import { RpcExportCommunityModLogsParamSchema } from "../../../dist/node/clients/rpc-client/schema.js";
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

    it.sequential("exports mod logs on a never-started community, opening then closing the DB it created", async () => {
        // Fresh community instance for the same owned address, created but never start()ed: this is the
        // initDbHandlerIfNeeded "create the handler if missing" branch the started/stopped tests don't hit.
        const neverStarted = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;
        expect(neverStarted).to.be.instanceOf((community as LocalCommunity).constructor);
        expect(neverStarted.state).to.equal("stopped");
        const { moderations } = await neverStarted.exportCommunityModLogs({ commentCid: postCid });
        const mod = moderations.find((m) => m.commentCid === postCid);
        expect(mod, "moderation should be readable from a never-started community").to.exist;
        expect(mod!.commentModeration.removed).to.equal(true);
        // The handler was created on demand purely for this read; it must not be left open.
        expect(isDbOpen(neverStarted)).to.equal(false);
    });
});

// Error paths for the base RemoteCommunity.exportCommunityModLogs() stub. Mirrors export.test.ts:
// the embedded variant builds a read-only RemoteCommunity from a second dataPath-less PKC; the RPC
// variant asks the daemon for an address it doesn't host so the client returns an RpcRemoteCommunity.
// Both inherit the base stub that rejects with ERR_COMMUNITY_NOT_LOCAL.
describe("community.exportCommunityModLogs() — error paths", () => {
    itSkipIfRpc("a read-only RemoteCommunity rejects with ERR_COMMUNITY_NOT_LOCAL", async () => {
        const pkc1 = await mockPKC({});
        const localComm = (await createSubWithNoChallenge({}, pkc1)) as LocalCommunity;
        await localComm.start();
        await resolveWhenConditionIsTrue({ toUpdate: localComm, predicate: async () => typeof localComm.updatedAt === "number" });

        const pkc2 = await mockPKCNoDataPathWithOnlyKuboClient();
        const remoteComm = await pkc2.createCommunity({ address: localComm.address });
        try {
            await expect(remoteComm.exportCommunityModLogs()).rejects.toMatchObject({ code: "ERR_COMMUNITY_NOT_LOCAL" });
        } finally {
            await localComm.stop();
            await pkc1.destroy();
            await pkc2.destroy();
        }
    });

    itIfRpc("an RpcRemoteCommunity rejects with ERR_COMMUNITY_NOT_LOCAL", async () => {
        const pkc = await mockRpcRemotePKC();
        try {
            // Fresh signer → address the RPC server has never hosted, so pkc-with-rpc-client.ts returns an
            // RpcRemoteCommunity (no exportCommunityModLogs override) and the call hits the base stub client-side.
            const freshSigner = await pkc.createSigner();
            const remoteComm = await pkc.createCommunity({ address: freshSigner.address });
            expect(remoteComm).not.toBeInstanceOf(RpcLocalCommunity);
            await expect(remoteComm.exportCommunityModLogs()).rejects.toMatchObject({ code: "ERR_COMMUNITY_NOT_LOCAL" });
        } finally {
            await pkc.destroy();
        }
    });
});

// RPC wire-param contract for exportCommunityModLogs. The param schema is pure validation (no server),
// so it runs in any config; the ERR_COMMUNITY_NOT_FOUND path needs a live daemon and is RPC-only.
describe("community.exportCommunityModLogs() — RPC param contract", () => {
    it("param schema requires at least one of name / publicKey", () => {
        // No identity → refinement fails.
        expect(RpcExportCommunityModLogsParamSchema.safeParse({}).success).to.equal(false);
        expect(RpcExportCommunityModLogsParamSchema.safeParse({ limit: 1 }).success).to.equal(false);
        // Either identifier alone is enough.
        expect(RpcExportCommunityModLogsParamSchema.safeParse({ name: "some-community.eth" }).success).to.equal(true);
        expect(RpcExportCommunityModLogsParamSchema.safeParse({ publicKey: "12D3KooWSomePublicKey" }).success).to.equal(true);
        // Filter options still flow through alongside identity.
        expect(
            RpcExportCommunityModLogsParamSchema.safeParse({ name: "some-community.eth", commentCid: "Qm...", order: "ASC" }).success
        ).to.equal(true);
    });

    itIfRpc("the RPC server rejects with ERR_COMMUNITY_NOT_FOUND for an address it does not host", async () => {
        const pkc = await mockRpcRemotePKC();
        try {
            const freshSigner = await pkc.createSigner();
            // Call the raw client so we bypass RpcLocalCommunity (which only exists for owned communities)
            // and exercise the server's _findCommunityAddress → not-found branch directly.
            await expect(pkc._pkcRpcClient!.exportCommunityModLogs({ name: freshSigner.address })).rejects.toMatchObject({
                code: "ERR_COMMUNITY_NOT_FOUND"
            });
        } finally {
            await pkc.destroy();
        }
    });
});

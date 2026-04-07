import assert from "assert";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../../dist/node/test/test-util.js";
import type { CommentsTableRowInsert } from "../../../dist/node/publications/comment/types.js";

interface InsertCommentOptions
    extends Partial<
        Pick<CommentsTableRowInsert, "cid" | "depth" | "parentCid" | "postCid" | "timestamp" | "authorSignerAddress" | "pendingApproval">
    > {
    overrides?: Partial<CommentsTableRowInsert>;
}

describeSkipIfRpc("db-handler.queryAuthorPublicationCounts", () => {
    let dbHandler: DbHandler | undefined;
    let communityAddress: string;
    let cidCounter = 0;

    const protocolVersion = "1.0.0";
    const nextCid = (prefix = "QmCountTest"): string => `${prefix}${(cidCounter++).toString().padStart(4, "0")}`;
    const currentTimestamp = (): number => Math.floor(Date.now() / 1000);

    async function createTestDbHandler(): Promise<DbHandler> {
        communityAddress = `test-sub-${Date.now()}-${Math.random()}`;
        const fakePKC = { noData: true };
        const fakeCommunity = { address: communityAddress, _pkc: fakePKC };
        const handler = new DbHandler(fakeCommunity as never);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
        return handler;
    }

    const insertComment = ({
        cid = nextCid(),
        depth = 0,
        parentCid = null,
        postCid,
        timestamp = currentTimestamp(),
        authorSignerAddress = `12D3KooAuthor${cid}`,
        pendingApproval,
        overrides = {}
    }: InsertCommentOptions = {}) => {
        assert(dbHandler, "DbHandler not initialized");
        const resolvedPostCid = postCid ?? (depth === 0 ? cid : parentCid ?? nextCid("QmRoot"));
        const comment: CommentsTableRowInsert = {
            cid,
            authorSignerAddress,
            author: overrides.author ?? { address: authorSignerAddress },
            content: overrides.content ?? `content-${cid}`,
            title: depth === 0 ? overrides.title ?? `title-${cid}` : undefined,
            communityPublicKey: communityAddress,
            timestamp,
            depth,
            postCid: resolvedPostCid,
            parentCid: depth === 0 ? undefined : parentCid ?? undefined,
            signature: overrides.signature ?? { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] },
            protocolVersion,
            pendingApproval,
            insertedAt: overrides.insertedAt ?? timestamp
        };
        dbHandler.insertComments([comment]);
        return { cid, postCid: resolvedPostCid };
    };

    beforeEach(async () => {
        dbHandler = await createTestDbHandler();
        assert(dbHandler, "Failed to initialize DbHandler");
    });

    afterEach(async () => {
        if (dbHandler) {
            await dbHandler.destoryConnection();
            dbHandler = undefined;
        }
        cidCounter = 0;
    });

    it("filters pending approval comments out of postCount and replyCount", () => {
        assert(dbHandler, "DbHandler not initialized");
        const authorSignerAddress = "12D3KooAuthorShared";

        const approvedPost = insertComment({
            authorSignerAddress,
            depth: 0,
            pendingApproval: undefined
        });
        insertComment({
            authorSignerAddress,
            depth: 0,
            pendingApproval: true
        });

        insertComment({
            authorSignerAddress,
            depth: 1,
            parentCid: approvedPost.cid,
            postCid: approvedPost.postCid,
            pendingApproval: undefined
        });
        insertComment({
            authorSignerAddress,
            depth: 1,
            parentCid: approvedPost.cid,
            postCid: approvedPost.postCid,
            pendingApproval: true
        });

        const counts = dbHandler.queryAuthorPublicationCounts(authorSignerAddress);
        expect(counts.postCount).to.equal(1);
        expect(counts.replyCount).to.equal(1);
    });

    it("counts approved comments when pendingApproval is false", () => {
        assert(dbHandler, "DbHandler not initialized");
        const authorSignerAddress = "12D3KooAuthorApproved";

        const approvedPost = insertComment({
            authorSignerAddress,
            depth: 0,
            pendingApproval: false
        });
        insertComment({
            authorSignerAddress,
            depth: 1,
            parentCid: approvedPost.cid,
            postCid: approvedPost.postCid,
            pendingApproval: false
        });

        const counts = dbHandler.queryAuthorPublicationCounts(authorSignerAddress);
        expect(counts.postCount).to.equal(1);
        expect(counts.replyCount).to.equal(1);
    });
});

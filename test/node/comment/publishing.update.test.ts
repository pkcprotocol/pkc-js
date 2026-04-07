import { describeSkipIfRpc } from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import { createSigner } from "../../../dist/node/signer/index.js";
import { of as calculateIpfsCidV0Lib } from "typestub-ipfs-only-hash";
import type {
    CommentUpdateType,
    CommentsTableRowInsert,
    CommentWithinRepliesPostsPageJson,
    CommentIpfsType
} from "../../../dist/node/publications/comment/types.js";
import type { JsonSignature } from "../../../dist/node/signer/types.js";
import { describe, it } from "vitest";

// Test-specific interfaces
interface PublishingTestContext {
    rowsByDepth: Map<number, CommentsTableRowInsert>;
    expectedUpdates: Map<string, CommentUpdateType>;
    calculateUpdate: (commentRow: CommentsTableRowInsert) => Promise<{
        newCommentUpdate: CommentUpdateType & { replies?: { pages?: { best?: { comments: { cid: string }[] } } } };
        localMfsPath: string | undefined;
    }>;
    cleanup: () => Promise<void>;
}

interface MockPageGeneratorResult {
    singlePreloadedPage: {
        best: {
            comments: CommentWithinRepliesPostsPageJson[];
        };
    };
}

// Test constants
const SUBPLEBBIT_ADDRESS = signers[0].address;
const PROTOCOL_VERSION = "1.0.0";
const MOCK_SIGNATURE: JsonSignature = {
    type: "ed25519",
    signature: "mocksignature",
    publicKey: "mockpublickey",
    signedPropertyNames: ["author", "content", "timestamp", "subplebbitAddress"]
};
const depthsToTest = [1, 2, 3, 15, 30];

describeSkipIfRpc("comment.update publishing depth coverage", function () {
    depthsToTest.forEach((depth) => {
        it(`Local community generates comment updates for replies at depth ${depth}`, async () => {
            const context = await createPublishingTestContext({ targetDepth: depth });
            try {
                const leafRow = context.rowsByDepth.get(depth);
                expect(leafRow, "Leaf comment should exist").to.exist;
                const leafResult = await context.calculateUpdate(leafRow!);
                const expectedLeaf = context.expectedUpdates.get(leafRow!.cid);

                expect(leafResult.newCommentUpdate.replyCount).to.equal(expectedLeaf!.replyCount);
                expect(leafResult.newCommentUpdate.childCount).to.equal(expectedLeaf!.childCount);
                expect(leafResult.newCommentUpdate.updatedAt).to.be.a("number");

                if (depth > 0) {
                    const parentRow = context.rowsByDepth.get(depth - 1);
                    const parentResult = await context.calculateUpdate(parentRow!);
                    const expectedParent = context.expectedUpdates.get(parentRow!.cid);

                    expect(parentResult.newCommentUpdate.replyCount).to.equal(expectedParent!.replyCount);
                    expect(parentResult.newCommentUpdate.childCount).to.equal(expectedParent!.childCount);

                    const replies = parentResult.newCommentUpdate.replies?.pages?.best?.comments || [];
                    expect(replies.map((reply) => reply.cid)).to.include(leafRow!.cid);
                    expect(leafResult.localMfsPath).to.be.undefined;
                } else {
                    expect(leafResult.localMfsPath).to.be.a("string");
                }
            } finally {
                await context.cleanup();
            }
        });
    });
});

async function createPublishingTestContext({ targetDepth }: { targetDepth: number }): Promise<PublishingTestContext> {
    const _dbHandler = await createTestDbHandler();
    const { rows, childrenByParent } = await seedCommentChain({
        depth: targetDepth,
        _dbHandler
    });
    const rowsByDepth = new Map(rows.map((row) => [row.depth, row]));
    const calculatedUpdates = new Map(
        rows.map((row) => [row.cid, _dbHandler.queryCalculatedCommentUpdate({ comment: row }) as CommentUpdateType])
    );
    const pageGenerator = new MockPageGenerator(childrenByParent, calculatedUpdates);
    const signer = await createSigner();

    const fakeSub = {
        address: SUBPLEBBIT_ADDRESS,
        signer,
        _pageGenerator: pageGenerator,
        _postUpdatesBuckets: [86400, 604800, 2592000, 3153600000],
        _pkc: { validatePages: false },
        _cidsToUnPin: new Set<string>(),
        _mfsPathsToRemove: new Set<string>(),
        _dbHandler: {
            queryStoredCommentUpdate: (): undefined => undefined,
            queryCalculatedCommentUpdate: (opts: Parameters<DbHandler["queryCalculatedCommentUpdate"]>[0]) =>
                clone(calculatedUpdates.get(opts.comment.cid))
        }
    };

    // Bind the private method using prototype access
    type PrivateMethod = (...args: unknown[]) => unknown;
    const localSubPrototype = LocalCommunity.prototype as never as Record<string, PrivateMethod>;
    (fakeSub as Record<string, unknown>)._calculateLocalMfsPathForCommentUpdate =
        localSubPrototype._calculateLocalMfsPathForCommentUpdate.bind(fakeSub);
    (fakeSub as Record<string, unknown>)._validateCommentUpdateSignature = async () => {};
    (fakeSub as Record<string, unknown>)._addOldPageCidsToCidsToUnpin = async () => {};

    return {
        rowsByDepth,
        expectedUpdates: calculatedUpdates,
        calculateUpdate: (commentRow: CommentsTableRowInsert) =>
            localSubPrototype._calculateNewCommentUpdate.call(fakeSub, commentRow) as Promise<{
                newCommentUpdate: CommentUpdateType & { replies?: { pages?: { best?: { comments: { cid: string }[] } } } };
                localMfsPath: string | undefined;
            }>,
        cleanup: async () => {
            await _dbHandler.destoryConnection();
        }
    };
}

async function createTestDbHandler(): Promise<DbHandler> {
    const communityAddress = `${SUBPLEBBIT_ADDRESS}-${Date.now()}-${Math.random()}`;
    const fakePKC = { noData: true };
    const fakeCommunity = { address: communityAddress, _pkc: fakePKC };
    const handler = new DbHandler(fakeCommunity as never);
    await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
    await handler.createOrMigrateTablesIfNeeded();
    return handler;
}

async function seedCommentChain({
    depth,
    _dbHandler
}: {
    depth: number;
    _dbHandler: DbHandler;
}): Promise<{ rows: CommentsTableRowInsert[]; childrenByParent: Map<string, CommentsTableRowInsert[]> }> {
    const rows: CommentsTableRowInsert[] = [];
    const childrenByParent = new Map<string, CommentsTableRowInsert[]>();
    const baseTimestamp = Math.floor(Date.now() / 1000);
    let rootCid: string | undefined;
    let previousCid: string | null = null;

    for (let curDepth = 0; curDepth <= depth; curDepth++) {
        const cid = await createMockCid(`publish-depth-${depth}-${curDepth}`);
        if (!rootCid) rootCid = cid;
        const timestamp = baseTimestamp + curDepth;
        const row: CommentsTableRowInsert = {
            cid,
            authorSignerAddress: `author-${cid}`,
            author: { address: `author-${cid}` },
            content: `content-${cid}`,
            title: curDepth === 0 ? `title-${cid}` : null,
            communityPublicKey: SUBPLEBBIT_ADDRESS,
            communityName: undefined,
            timestamp,
            depth: curDepth,
            postCid: rootCid,
            parentCid: curDepth === 0 ? null : previousCid,
            signature: MOCK_SIGNATURE,
            protocolVersion: PROTOCOL_VERSION,
            pendingApproval: null,
            insertedAt: timestamp,
            flairs: null,
            spoiler: false,
            nsfw: false,
            previousCid: undefined,
            link: null,
            linkWidth: null,
            linkHeight: null,
            thumbnailUrl: null,
            thumbnailUrlWidth: null,
            thumbnailUrlHeight: null,
            extraProps: null
        };
        _dbHandler.insertComments([row as never]);
        rows.push(row);
        if (row.parentCid) {
            if (!childrenByParent.has(row.parentCid)) childrenByParent.set(row.parentCid, []);
            childrenByParent.get(row.parentCid)!.push(row);
        }
        previousCid = cid;
    }

    return { rows, childrenByParent };
}

class MockPageGenerator {
    childrenByParent: Map<string, CommentsTableRowInsert[]>;
    calculatedUpdates: Map<string, CommentUpdateType>;

    constructor(childrenByParent: Map<string, CommentsTableRowInsert[]>, calculatedUpdates: Map<string, CommentUpdateType>) {
        this.childrenByParent = childrenByParent;
        this.calculatedUpdates = calculatedUpdates;
    }

    async generatePostPages(comment: { cid: string }): Promise<MockPageGeneratorResult | undefined> {
        return this._buildPagePayload(comment.cid);
    }

    async generateReplyPages(comment: { cid: string }): Promise<MockPageGeneratorResult | undefined> {
        return this._buildPagePayload(comment.cid);
    }

    _buildPagePayload(parentCid: string): MockPageGeneratorResult | undefined {
        const children = this.childrenByParent.get(parentCid);
        if (!children || children.length === 0) return undefined;
        return {
            singlePreloadedPage: {
                best: {
                    comments: children.map((childRow) => buildRepliesPageEntry(childRow, clone(this.calculatedUpdates.get(childRow.cid))))
                }
            }
        };
    }
}

function buildRepliesPageEntry(row: CommentsTableRowInsert, commentUpdate: CommentUpdateType): CommentWithinRepliesPostsPageJson {
    const author = {
        address: row.authorSignerAddress,
        displayName: `Author-${row.authorSignerAddress.slice(-4)}`,
        shortAddress: `${row.authorSignerAddress.slice(0, 4)}…${row.authorSignerAddress.slice(-4)}`
    };
    const communityAddress = row.communityPublicKey ?? "";
    const comment: CommentIpfsType = {
        cid: row.cid,
        postCid: row.postCid,
        depth: row.depth,
        communityPublicKey: row.communityPublicKey,
        timestamp: row.timestamp,
        content: row.content,
        signature: MOCK_SIGNATURE,
        author,
        protocolVersion: PROTOCOL_VERSION,
        spoiler: false,
        nsfw: false,
        ...(row.parentCid && { parentCid: row.parentCid }),
        ...(row.title && { title: row.title })
    } as never;
    const entry = {
        cid: row.cid,
        postCid: row.postCid,
        depth: row.depth,
        communityAddress,
        timestamp: row.timestamp,
        shortCid: row.cid.slice(0, 8),
        shortCommunityAddress: communityAddress.slice(0, 8),
        author,
        original: { content: row.content },
        commentUpdate,
        raw: { comment, commentUpdate },
        ...(row.parentCid && { parentCid: row.parentCid })
    };
    return entry as never;
}

async function createMockCid(seed: string): Promise<string> {
    return calculateIpfsCidV0Lib(`${seed}-${Date.now()}-${Math.random()}`);
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

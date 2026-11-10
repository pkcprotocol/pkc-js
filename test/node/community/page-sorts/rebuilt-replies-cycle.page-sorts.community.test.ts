import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import Logger from "@pkcprotocol/pkc-logger";
import { it, expect, vi } from "vitest";
import {
    mockPKC,
    createSubWithNoChallenge,
    publishRandomPost,
    publishRandomReply,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { verifyCommentUpdate } from "../../../../dist/node/signer/signatures.js";
import { KEYWORD_FILTER_SORT_PATH } from "./page-sorts-test-util.js";
import path from "node:path";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined, CommentUpdateType } from "../../../../dist/node/publications/comment/types.js";
import type { CommunitySettings } from "../../../../dist/node/community/types.js";

// Free signer/verify helpers and raw clients take a required log (issue #493); tests use the process-default root
const testLog = Logger({ namespace: "pkc-js:test:rebuilt-replies-cycle" });

// Issue #477. With validatePages the community verifies each CommentUpdate it signs, nested pages included, so a rebuilt
// reply that differs from its signed form throws ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID and nothing above that depth is
// ever recalculated. Each case publishes real comments and must reach the post's real replyCount, then a client loading
// the post through the verifying path must agree.
// Needs a LocalCommunity whose owner PKC validates pages, so it cannot run over RPC.

type Parent = CommentIpfsWithCidDefined;
type Reply = (parent: Parent, content: string) => Promise<Parent>;

const FLAT_DIRECT_REPLIES_ONLY_SORT_PATH = path.resolve(process.cwd(), "test/fixtures/page-sorts/flat-direct-replies-only.js");

async function expectCycleConverges(args: {
    pages?: NonNullable<CommunitySettings["pages"]>;
    expectedReplyCount: number;
    build: (post: Parent, reply: Reply) => Promise<void>;
    afterConverged?: (ctx: { postInstance: Comment; pkc: PKCType; community: LocalCommunity }) => Promise<void>;
}) {
    const pkc: PKCType = await mockPKC({ validatePages: true });
    const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
    try {
        if (args.pages) await community.edit({ settings: { ...community.settings, pages: args.pages } });
        const errorCodes: (string | undefined)[] = [];
        community.on("error", (error) => errorCodes.push((error as { code?: string }).code));
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const post = (await publishRandomPost({ communityAddress: community.address, pkc })) as Parent;
        await args.build(post, async (parent, content) => {
            return (await publishRandomReply({ parentComment: parent, pkc, commentProps: { content } })) as Parent;
        });

        const signatureError = () => errorCodes.includes("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID");
        const storedReplyCount = () =>
            (
                community._dbHandler["_db"].prepare("SELECT replyCount FROM commentUpdates WHERE cid = ?").get(post.cid) as
                    | { replyCount: number }
                    | undefined
            )?.replyCount;
        // Polled: a wedged community stops emitting the update a predicate would be re-checked on
        await vi.waitFor(
            () => {
                if (!signatureError() && storedReplyCount() !== args.expectedReplyCount) throw new Error("the cycle has not converged yet");
            },
            { timeout: 60_000, interval: 100 }
        );
        expect(errorCodes).to.not.include("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID");
        expect(storedReplyCount()).to.equal(args.expectedReplyCount);

        const postInstance = await pkc.createComment({ cid: post.cid });
        const clientErrors: Error[] = [];
        postInstance.on("error", (error) => clientErrors.push(error));
        await postInstance.update();
        try {
            await resolveWhenConditionIsTrue({
                toUpdate: postInstance,
                predicate: async () => clientErrors.length > 0 || postInstance.replyCount === args.expectedReplyCount
            });
        } finally {
            await postInstance.stop();
        }
        expect(clientErrors.map((error) => error.message)).to.deep.equal([]);
        expect(postInstance.replyCount).to.equal(args.expectedReplyCount);
        await args.afterConverged?.({ postInstance, pkc, community });
    } finally {
        await community.stop();
        await pkc.destroy();
    }
}

describeSkipIfRpc("issue #477: the update cycle converges with validatePages", () => {
    it("a preloaded sort next to a non-preloaded sort, three levels deep", async () => {
        await expectCycleConverges({
            pages: {
                replies: [{ path: KEYWORD_FILTER_SORT_PATH, options: { dropKeywords: "DROPME" }, preloaded: true }, { name: "new" }]
            },
            expectedReplyCount: 4,
            build: async (post, reply) => {
                const d1 = await reply(post, "d1");
                const d2 = await reply(d1, "d2");
                await reply(d2, "d3");
                await reply(d2, "DROPME");
            }
        });
    });

    it("an unconfigured community with a reply over its 256 KiB inline budget, comments within the size limit", async () => {
        await expectCycleConverges({
            expectedReplyCount: 10,
            build: async (post, reply) => {
                const parent = await reply(post, "parent");
                const busy = await reply(parent, "busy");
                await Promise.all(Array.from({ length: 8 }, (_, i) => reply(busy, `${i}-`.repeat(19000))));
            }
        });
    });

    it("a preloaded flat sort next to a preloaded nested sort", async () => {
        await expectCycleConverges({
            pages: {
                replies: [
                    { name: "best", preloaded: true },
                    { name: "newFlat", preloaded: true }
                ]
            },
            expectedReplyCount: 3,
            build: async (post, reply) => {
                const r1 = await reply(post, "r1");
                const r2 = await reply(r1, "r2");
                await reply(r2, "r3");
            },
            // Leaving a flat entry's own signature unchecked must not open a hole: the post's signature covers the page
            afterConverged: async ({ postInstance, pkc, community }) => {
                const update = JSON.parse(JSON.stringify(postInstance.raw.commentUpdate)) as CommentUpdateType;
                const verify = (toVerify: CommentUpdateType) =>
                    verifyCommentUpdate({
                        update: toVerify,
                        resolveAuthorNames: false,
                        clientsManager: pkc._clientsManager,
                        community,
                        comment: {
                            signature: postInstance.signature,
                            cid: postInstance.cid!,
                            depth: 0,
                            postCid: postInstance.cid!
                        },
                        validatePages: true,
                        validateUpdateSignature: true,
                        log: testLog
                    });
                expect((await verify(update)).valid).to.equal(true);
                const flatEntry = update.replies!.pages.newFlat!.comments![0].commentUpdate as CommentUpdateType;
                flatEntry.upvoteCount = flatEntry.upvoteCount + 1;
                expect((await verify(update)).valid).to.equal(false);
            }
        });
    });

    it("a preloaded flat sort left with only direct replies next to a preloaded nested sort", async () => {
        await expectCycleConverges({
            pages: {
                replies: [
                    { name: "best", preloaded: true },
                    { path: FLAT_DIRECT_REPLIES_ONLY_SORT_PATH, preloaded: true }
                ]
            },
            expectedReplyCount: 2,
            build: async (post, reply) => {
                const r1 = await reply(post, "r1");
                await reply(r1, "r2");
            }
        });
    });
});

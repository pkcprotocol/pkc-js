import { describe, it } from "vitest";
import {
    mockPKC,
    publishRandomPost,
    publishRandomReply,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    waitTillReplyInParentPages,
    mockPKCNoDataPathWithOnlyKuboClient
} from "../../../dist/node/test/test-util.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

const depth = 100;

describe.skip(`Test for maximum depth of ${depth}`, () => {
    it(`should be able to create a community with a depth of ${depth}`, async () => {
        const pkc = await mockPKC();
        const community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        const post: Comment = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
        let lastReply: Comment | undefined;
        for (let i = 0; i < depth; i++) {
            lastReply = await publishRandomReply({
                parentComment: (lastReply || post) as CommentIpfsWithCidDefined,
                pkc: remotePKC
            });
            expect(lastReply.depth).to.equal(i + 1);
            console.log("Published reply with depth", lastReply.depth);
        }
        const lastReplyRemote: Comment = await remotePKC.getComment({ cid: lastReply!.cid! });
        await waitTillReplyInParentPages(lastReplyRemote as Comment & { cid: string; parentCid: string }, remotePKC);
        expect(lastReplyRemote.depth).to.equal(depth);
        await community.delete();
    });
});

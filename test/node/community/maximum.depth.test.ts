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
    it(`should be able to create a subplebbit with a depth of ${depth}`, async () => {
        const plebbit = await mockPKC();
        const sub = await createSubWithNoChallenge({}, plebbit);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

        const remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        const post: Comment = await publishRandomPost({ communityAddress: sub.address, plebbit: remotePKC });
        let lastReply: Comment | undefined;
        for (let i = 0; i < depth; i++) {
            lastReply = await publishRandomReply({
                parentComment: (lastReply || post) as CommentIpfsWithCidDefined,
                plebbit: remotePKC
            });
            expect(lastReply.depth).to.equal(i + 1);
            console.log("Published reply with depth", lastReply.depth);
        }
        const lastReplyRemote: Comment = await remotePKC.getComment({ cid: lastReply!.cid! });
        await waitTillReplyInParentPages(lastReplyRemote as Comment & { cid: string; parentCid: string }, remotePKC);
        expect(lastReplyRemote.depth).to.equal(depth);
        await sub.delete();
    });
});

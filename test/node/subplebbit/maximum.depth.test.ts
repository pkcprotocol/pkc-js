import { describe, it } from "vitest";
import {
    mockPlebbit,
    publishRandomPost,
    publishRandomReply,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    waitTillReplyInParentPages,
    mockPlebbitNoDataPathWithOnlyKuboClient
} from "../../../dist/node/test/test-util.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

// A reply is a comment with parentCid defined
interface ReplyIpfsWithCidDefined extends CommentIpfsWithCidDefined {
    parentCid: string;
}

const depth = 100;

describe.skip(`Test for maximum depth of ${depth}`, () => {
    it(`should be able to create a subplebbit with a depth of ${depth}`, async () => {
        const plebbit = await mockPlebbit();
        const sub = await createSubWithNoChallenge({}, plebbit);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

        const remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        const post: Comment = await publishRandomPost({ subplebbitAddress: sub.address, plebbit: remotePlebbit });
        let lastReply: Comment | undefined;
        for (let i = 0; i < depth; i++) {
            lastReply = await publishRandomReply({
                parentComment: (lastReply || post) as CommentIpfsWithCidDefined,
                plebbit: remotePlebbit
            });
            expect(lastReply.depth).to.equal(i + 1);
            console.log("Published reply with depth", lastReply.depth);
        }
        const lastReplyRemote: Comment = await remotePlebbit.getComment({ cid: lastReply!.cid! });
        await waitTillReplyInParentPages(lastReplyRemote as ReplyIpfsWithCidDefined, remotePlebbit);
        expect(lastReplyRemote.depth).to.equal(depth);
        await sub.delete();
    });
});

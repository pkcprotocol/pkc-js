// Issue #572: a challenge can return { success: true, commentUpdate: { someKey } } with a key that is
// NOT part of CommentUpdateSchema. The key is signed into the challenge-verification message, and it is
// seeded into the regular CommentUpdate the community publishes afterwards (db-handler
// queryCalculatedCommentUpdate). The regular CommentUpdate must therefore sign it too: otherwise the
// community's own verifyCommentUpdate rejects the record (ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID)
// and the whole update cycle stalls.

import {
    mockPKC,
    mockGatewayPKC,
    publishRandomPost,
    publishRandomReply,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { verifyCommentUpdate } from "../../../../dist/node/signer/signatures.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { ChallengeResult } from "../../../../dist/node/community/types.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import Logger from "@pkcprotocol/pkc-logger";

const testLog = Logger({ namespace: "pkc-js:test:challenge-extra-key-regular-commentupdate" });

const EXTRA_KEY_VALUE = { chainId: 1, note: "hello" };

// A challenge that accepts everything and sets one key that CommentUpdateSchema does not know.
const createExtraKeyChallengeFactory = () => () => ({
    type: "text/plain" as const,
    getChallenge: async (): Promise<ChallengeResult> => {
        // ChallengeResult only types { success }; production challenges attach a commentUpdate.
        const result: ChallengeResult & { commentUpdate?: { myExtraKey: typeof EXTRA_KEY_VALUE } } = {
            success: true,
            commentUpdate: { myExtraKey: EXTRA_KEY_VALUE }
        };
        return result;
    }
});

// LocalCommunity-only: registers an in-process challenge factory the RPC server can't see.
describeSkipIfRpc("challenge-supplied commentUpdate extra key on a regular comment (issue #572)", async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    const emittedErrors: { code?: string; message: string }[] = [];

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockGatewayPKC();
        pkc.settings = { challenges: { "extra-key-challenge": createExtraKeyChallengeFactory() } };

        community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        community.setMaxListeners(100);
        community.on("error", (err: Error & { code?: string }) => emittedErrors.push({ code: err.code, message: err.message }));
        await community.edit({ settings: { challenges: [{ name: "extra-key-challenge" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it("signs the extra key into the regular CommentUpdate and a client reads it back", async () => {
        const post = (await publishRandomPost({ communityAddress: community.address, pkc: remotePKC })) as Comment;

        await post.update();
        // stop waiting as soon as the community reports a failed update cycle: that is the #572 failure
        await resolveWhenConditionIsTrue({
            toUpdate: post,
            predicate: async () => typeof post.raw.commentUpdate?.cid === "string" || emittedErrors.length > 0
        });
        expect(emittedErrors).to.deep.equal([]);

        const rawUpdate = post.raw.commentUpdate as Record<string, unknown> & { signature: { signedPropertyNames: string[] } };
        expect(rawUpdate.myExtraKey).to.deep.equal(EXTRA_KEY_VALUE);
        expect(rawUpdate.signature.signedPropertyNames).to.include("myExtraKey");
        // unknown CommentUpdate props land on the Comment instance
        expect((post as unknown as Record<string, unknown>).myExtraKey).to.deep.equal(EXTRA_KEY_VALUE);

        await post.stop();
    });

    it("the community's page entry for the comment is the signed record: it carries the key and its signature verifies", async () => {
        const post = (await publishRandomPost({ communityAddress: community.address, pkc: remotePKC })) as Comment;

        const remoteCommunity = await remotePKC.createCommunity({ address: community.address });
        await remoteCommunity.update();
        const findEntry = () =>
            Object.values(remoteCommunity.raw.communityIpfs?.posts?.pages ?? {})
                .flatMap((page) => page.comments)
                .find((entry) => entry.commentUpdate.cid === post.cid);
        await resolveWhenConditionIsTrue({
            toUpdate: remoteCommunity,
            predicate: async () => findEntry() !== undefined || emittedErrors.length > 0
        });
        expect(emittedErrors).to.deep.equal([]);

        const entry = findEntry()!;
        const pageUpdate = entry.commentUpdate as typeof entry.commentUpdate & { myExtraKey?: unknown };
        expect(pageUpdate.myExtraKey).to.deep.equal(EXTRA_KEY_VALUE);
        expect(pageUpdate.signature.signedPropertyNames).to.include("myExtraKey");

        // the page entry must verify against its own signature, which covers the extra key
        const verification = await verifyCommentUpdate({
            update: entry.commentUpdate,
            resolveAuthorNames: false,
            clientsManager: remoteCommunity._clientsManager,
            community: remoteCommunity,
            comment: { signature: entry.comment.signature, cid: post.cid!, depth: 0, postCid: post.cid! },
            validatePages: false,
            validateUpdateSignature: true,
            log: testLog
        });
        expect(verification).to.deep.equal({ valid: true });

        await remoteCommunity.stop();
    });

    it("a reply with the extra key does not stall the update cycle, and the community emits no error", async () => {
        const post = (await publishRandomPost({ communityAddress: community.address, pkc: remotePKC })) as Comment;
        const reply = (await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc: remotePKC })) as Comment;

        // the post's update must pick up the reply: that only happens when the update cycle is not stalled
        await post.update();
        await resolveWhenConditionIsTrue({
            toUpdate: post,
            predicate: async () => ((post.replyCount ?? 0) >= 1 && post.lastChildCid === reply.cid) || emittedErrors.length > 0
        });

        expect(emittedErrors).to.deep.equal([]);
        await post.stop();
    });
});

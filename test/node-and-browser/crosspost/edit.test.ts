// Crossposts (issue #32) — crossposts across edits and deletions.
//
// The whole reason the full CommentIpfs is embedded rather than referenced by cid is that the
// embedded copy is immutable: it is covered by the crossposting author's signature and hashed by
// crosspost.cid, so nothing the original author does afterwards can reach it. These pin that, from
// both directions: editing the crossposting comment must not disturb the embedded record, and
// editing or deleting the original must not either.
//
// Edits live in the CommentUpdate, never in the CommentIpfs, so an edited comment re-initialises
// through a different path than a freshly loaded one. That is what makes this worth asserting rather
// than assuming.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import signers from "../../fixtures/signers.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    generateMockPost,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { verifyCommentPubsubMessage } from "../../../dist/node/signer/signatures.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsType } from "../../../dist/node/publications/comment/types.js";

const communityAddress = signers[0].address;
const ORIGINAL_CONTENT = "the original text, as it was when it was crossposted";

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`crossposts across edits and deletions - ${config.name}`, async () => {
        let pkc: PKC;
        let original: Comment;
        let crosspost: { cid: string; comment: CommentIpfsType };
        let crossposting: Comment;

        // Loads the crossposting comment from scratch, so nothing is served from the instance that
        // published it.
        const reloadCrossposting = async () => {
            const loaded = await pkc.createComment({ cid: crossposting.cid! });
            await loaded.update();
            await resolveWhenConditionIsTrue({ toUpdate: loaded, predicate: async () => typeof loaded.updatedAt === "number" });
            return loaded;
        };

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            original = await publishRandomPost({ communityAddress, pkc, postProps: { content: ORIGINAL_CONTENT } });
            crosspost = { cid: original.cid!, comment: original.raw.comment! };

            crossposting = await generateMockPost({ communityAddress, pkc, postProps: { crosspost } });
            await publishWithExpectedResult({ publication: crossposting, expectedChallengeSuccess: true });
            await original.update();
        });

        afterAll(async () => {
            await original.stop();
            await pkc.destroy();
        });

        describe("editing the crossposting comment", () => {
            it.sequential("its own author editing the content leaves crosspost intact", async () => {
                const commentEdit = await pkc.createCommentEdit({
                    communityAddress,
                    commentCid: crossposting.cid,
                    content: "the crossposter changed their commentary" + Date.now(),
                    signer: crossposting.signer
                });
                await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });

                const loaded = await reloadCrossposting();
                await resolveWhenConditionIsTrue({
                    toUpdate: loaded,
                    predicate: async () => typeof loaded.edit?.content === "string"
                });
                expect(loaded.content).to.not.equal(crossposting.content);
                expect(loaded.crosspost?.cid).to.equal(crosspost.cid);
                expect(loaded.crosspost?.comment).to.deep.equal(crosspost.comment);
                await loaded.stop();
            });

            it.sequential("the embedded record still reproduces its own cid after the edit", async () => {
                const loaded = await reloadCrossposting();
                expect(await calculateIpfsHash(deterministicStringify(loaded.crosspost!.comment)!)).to.equal(crosspost.cid);
                await loaded.stop();
            });
        });

        // This is the property the embed exists for. A cid-only reference would have let the original
        // author rewrite or remove what the crosspost points at.
        describe("editing the original comment", () => {
            it.sequential("the original author editing their content does not change the embedded copy", async () => {
                const editedText = "the original author rewrote this afterwards" + Date.now();
                const commentEdit = await pkc.createCommentEdit({
                    communityAddress,
                    commentCid: original.cid,
                    content: editedText,
                    signer: original.signer
                });
                await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });
                await resolveWhenConditionIsTrue({ toUpdate: original, predicate: async () => original.content === editedText });

                const loaded = await reloadCrossposting();
                expect(loaded.crosspost!.comment.content).to.equal(ORIGINAL_CONTENT);
                expect(loaded.crosspost!.comment.content).to.not.equal(editedText);
                expect(loaded.crosspost?.comment).to.deep.equal(crosspost.comment);
                await loaded.stop();
            });

            it.sequential("the original author deleting their comment does not remove the embedded copy", async () => {
                const commentEdit = await pkc.createCommentEdit({
                    communityAddress,
                    commentCid: original.cid,
                    deleted: true,
                    signer: original.signer
                });
                await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });
                await resolveWhenConditionIsTrue({ toUpdate: original, predicate: async () => original.deleted === true });

                const loaded = await reloadCrossposting();
                expect(loaded.crosspost?.cid).to.equal(crosspost.cid);
                expect(loaded.crosspost!.comment.content).to.equal(ORIGINAL_CONTENT);
                await loaded.stop();
            });

            it.sequential("the crossposting comment still passes tier-1 verification after all of that", async () => {
                // Tier 1 reads only the embedded bytes, so a deleted original cannot invalidate it.
                const loaded = await reloadCrossposting();
                const keys = loaded.raw.comment!.signature.signedPropertyNames as (keyof CommentIpfsType)[];
                const asPubsubMessage = Object.fromEntries(
                    ["signature", ...keys].map((k) => [k, (loaded.raw.comment as Record<string, unknown>)[k as string]])
                );
                expect(
                    await verifyCommentPubsubMessage({
                        comment: asPubsubMessage as Parameters<typeof verifyCommentPubsubMessage>[0]["comment"],
                        resolveAuthorNames: false,
                        clientsManager: loaded._clientsManager
                    })
                ).to.deep.equal({ valid: true });
                await loaded.stop();
            });
        });
    });
});

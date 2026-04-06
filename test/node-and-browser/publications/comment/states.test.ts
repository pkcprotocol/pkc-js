import { beforeAll, afterAll, describe, it } from "vitest";
import signers from "../../../fixtures/signers.js";
import { generateMockPost, getAvailablePKCConfigsToTestAgainst, publishRandomPost } from "../../../../dist/node/test/test-util.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";

const subplebbitAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`comment.state - ${config.name}`, async () => {
        let plebbit: PKC;
        let comment: Comment;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            comment = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`state is stopped by default`, async () => {
            expect(comment.state).to.equal("stopped");
        });

        it(`state changes to publishing after calling .publish()`, async () => {
            await comment.publish();
            expect(comment.state).to.equal("publishing");
        });

        it(`state changes to stopped after calling .stop() when publishing`, async () => {
            await comment.stop();
            expect(comment.state).to.equal("stopped");
        });

        it(`state changes to stop after finishing publishing`, async () => {
            const newComment = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            expect(newComment.state).to.equal("stopped");
        });

        it(`state changes to updating after calling .update()`, async () => {
            const tempComment = await plebbit.createComment({
                cid: (await plebbit.getCommunity({ address: signers[0].address })).posts.pages.hot.comments[0].cid
            });
            await tempComment.update();
            expect(tempComment.state).to.equal("updating");
            await tempComment.stop();
            expect(tempComment.state).to.equal("stopped");
        });

        it(`state changes to updating after calling .update() when publishing`, async () => {
            const tempComment = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            expect(tempComment.state).to.equal("stopped");
            await tempComment.update();
            expect(tempComment.state).to.equal("updating");
            await tempComment.stop();
            expect(tempComment.state).to.equal("stopped");
        });
    });
});

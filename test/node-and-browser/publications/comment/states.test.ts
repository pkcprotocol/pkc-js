import { beforeAll, afterAll, describe, it } from "vitest";
import signers from "../../../fixtures/signers.js";
import { generateMockPost, getAvailablePKCConfigsToTestAgainst, publishRandomPost } from "../../../../dist/node/test/test-util.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`comment.state - ${config.name}`, async () => {
        let pkc: PKC;
        let comment: Comment;
        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
            comment = await generateMockPost({ communityAddress: communityAddress, plebbit: pkc });
        });

        afterAll(async () => {
            await pkc.destroy();
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
            const newComment = await publishRandomPost({ communityAddress: communityAddress, plebbit: pkc });
            expect(newComment.state).to.equal("stopped");
        });

        it(`state changes to updating after calling .update()`, async () => {
            const tempComment = await pkc.createComment({
                cid: (await pkc.getCommunity({ address: signers[0].address })).posts.pages.hot.comments[0].cid
            });
            await tempComment.update();
            expect(tempComment.state).to.equal("updating");
            await tempComment.stop();
            expect(tempComment.state).to.equal("stopped");
        });

        it(`state changes to updating after calling .update() when publishing`, async () => {
            const tempComment = await publishRandomPost({ communityAddress: communityAddress, plebbit: pkc });
            expect(tempComment.state).to.equal("stopped");
            await tempComment.update();
            expect(tempComment.state).to.equal("updating");
            await tempComment.stop();
            expect(tempComment.state).to.equal("stopped");
        });
    });
});

import { describe, it, expect } from "vitest";
import signers from "../../../../test/fixtures/signers.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    publishCommentWithDepth
} from "../../../../dist/node/test/test-util.js";

const depthsToTest = [0, 1, 2, 3, 10, 15];
const communityAddress = signers[0].address;
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-pkc-rpc"] }).map((config) => {
    depthsToTest.forEach((depthToTest) => {
        describe.concurrent("publish then update with pkc rpc client and depth=" + depthToTest + " - " + config.name, async () => {
            it("Should be able to fetch updates after publishing", async () => {
                const pkc = await config.pkcInstancePromise();
                const comment = await publishCommentWithDepth({
                    depth: depthToTest,
                    community: await pkc.getCommunity({ address: communityAddress })
                });

                expect(comment.cid).to.be.a("string");

                expect(comment.state).to.equal("stopped");

                expect(comment.updatedAt).to.be.undefined;

                await comment.update();

                await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

                expect(comment.updatedAt).to.be.a("number");
                expect(comment.raw.commentUpdate).to.be.ok;
            });
        });
    });
});

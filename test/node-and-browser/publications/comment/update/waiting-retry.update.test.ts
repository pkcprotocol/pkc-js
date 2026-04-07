import { describe } from "vitest";
import {
    itSkipIfRpc,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst,
    isPKCFetchingUsingGateways
} from "../../../../../dist/node/test/test-util.js";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`comment.update() waiting-retry errors - ${config.name}`, () => {
        itSkipIfRpc(
            `comment.update() emits error and changes updatingState to waiting-retry and keeps retrying if CommentIpfs loading times out`,
            async () => {
                // Create a comment with a CID that doesn't exist or will time out
                const pkc = await config.pkcInstancePromise();
                const nonExistentCid = "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGzx"; // Random CID that doesn't exist
                const createdComment = await pkc.createComment({ cid: nonExistentCid });

                pkc._timeouts["comment-ipfs"] = 100; // reduce timeout to 100ms

                let updateHasBeenEmitted = false;
                createdComment.once("update", () => (updateHasBeenEmitted = true));

                const waitingRetries: PKCError[] = [];
                createdComment.on("error", (err) => waitingRetries.push(err as PKCError));

                // Start the update process
                await createdComment.update();

                await resolveWhenConditionIsTrue({
                    toUpdate: createdComment,
                    predicate: async () => waitingRetries.length === 3,
                    eventName: "error"
                });

                await createdComment.stop();
                for (const waitingRetryErr of waitingRetries) {
                    if (isPKCFetchingUsingGateways(pkc)) {
                        expect(waitingRetryErr.code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_IPFS_FROM_GATEWAYS");
                        for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways))
                            expect(waitingRetryErr.details.gatewayToError[gatewayUrl].code).to.equal("ERR_GATEWAY_TIMED_OUT_OR_ABORTED");
                    } else {
                        expect(waitingRetryErr.code).to.equal("ERR_FETCH_CID_P2P_TIMEOUT");
                    }
                }

                expect(createdComment.depth).to.be.undefined; // Make sure it did not use any props from CommentIpfs
                expect(createdComment.state).to.equal("stopped");
                expect(createdComment.updatedAt).to.be.undefined;
                expect(updateHasBeenEmitted).to.be.false;
                await pkc.destroy();
            }
        );
    });
});

import { describe, expect } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    createMockedCommunityIpns,
    addStringToIpfs,
    resolveWhenConditionIsTrue,
    mockPKCNoDataPathWithOnlyKuboClient
} from "../../../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../../../helpers/conditional-tests.js";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`comment.update() during community key migration - ${config.name}`, () => {
        // Cannot run under RPC: test observes internal client-side event handling during key migration
        itSkipIfRpc(`comment.update() does not crash when community detects key migration`, async () => {
            // 1. Create a community IPNS record signed by a random key (oldPublicKey),
            //    with name: "migration-test.bso". The default mock resolver maps
            //    "migration-test.bso" → signers[0].address (a different key),
            //    which triggers key migration when the community resolves its name.
            const { communityAddress: oldPublicKey } = await createMockedCommunityIpns({
                name: "migration-test.bso"
            });

            // 2. Create a comment referencing this community and add it to IPFS.
            //    Since communityAddress is a raw public key (not a domain), createComment
            //    auto-signs with communityPublicKey derived from the address.
            const commentPKC = await mockPKCNoDataPathWithOnlyKuboClient();
            let commentCid: string;
            try {
                const commentToPublish = await commentPKC.createComment({
                    signer: await commentPKC.createSigner(),
                    communityAddress: oldPublicKey,
                    title: "Key migration test post",
                    content: "This comment tests key migration handling"
                });

                const commentIpfs: Record<string, unknown> = { ...commentToPublish.raw.pubsubMessageToPublish, depth: 0 };
                commentCid = await addStringToIpfs(JSON.stringify(commentIpfs));
            } finally {
                await commentPKC.destroy();
            }

            // 3. Create a PKC with the default mock resolver for the update test
            const testPKC = await config.pkcInstancePromise();
            try {
                const comment = await testPKC.createComment({ cid: commentCid });

                // Track unhandled rejections to detect the crash
                let unhandledRejection: unknown = undefined;
                const rejectionHandler = (reason: unknown) => {
                    unhandledRejection = reason;
                };
                process.on("unhandledRejection", rejectionHandler);

                // 4. Start the comment update — it will:
                //    a) Load CommentIpfs from IPFS
                //    b) Subscribe to community updates
                //    c) Community fetches its IPNS record → name "migration-test.bso"
                //    d) Background resolution: "migration-test.bso" → different key → key migration
                //    e) Community emits update with communityIpfs=undefined
                //    f) Comment's handleUpdateEventFromCommunity should NOT crash
                await comment.update();

                // Wait for CommentIpfs to load
                await resolveWhenConditionIsTrue({
                    toUpdate: comment,
                    predicate: async () => !!comment.raw.comment
                });

                // Wait for the key migration to occur and propagate
                await new Promise((resolve) => setTimeout(resolve, 5000));

                // 5. Assertions
                // The comment should still be in "updating" state (not crashed)
                expect(comment.state).to.equal("updating");

                // No unhandled promise rejection should have occurred
                expect(unhandledRejection).to.be.undefined;

                // CommentIpfs should still be intact
                expect(comment.raw.comment).to.not.be.undefined;
                expect(comment.title).to.equal("Key migration test post");

                // Clean up
                process.removeListener("unhandledRejection", rejectionHandler);
                await comment.stop();
            } finally {
                await testPKC.destroy();
            }
        });
    });
});

import { describe, expect } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    createMockedCommunityIpns,
    addStringToIpfs,
    resolveWhenConditionIsTrue,
    mockPKCNoDataPathWithOnlyKuboClient,
    createMockNameResolver
} from "../../../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../../../helpers/conditional-tests.js";
import signers from "../../../../fixtures/signers.js";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`comment.update() during community key migration - ${config.name}`, () => {
        // Cannot run under RPC: test observes internal client-side event handling during key migration
        itSkipIfRpc(`comment.update() does not crash when community detects key migration`, async () => {
            // 1. Create a community IPNS record signed by a random key (oldPublicKey) that claims a
            //    name of this test's own. The resolver below maps the name to signers[0] (a different
            //    key), which is a key migration for a loader that asked for the name.
            const communityName = `comment-update-migration-${Date.now()}.bso`;
            const migratedKey = signers[0].address;
            const { communityAddress: oldPublicKey } = await createMockedCommunityIpns({ name: communityName });

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

            // 3. A PKC whose resolver answers for the name only once the test releases it, so the
            //    comment is attached to the community's updating instance before the migration fires.
            let releaseResolve!: () => void;
            const resolveReleased = new Promise<void>((resolve) => (releaseResolve = resolve));
            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            resolveFunction: async ({ name }) => {
                                if (name !== communityName) return undefined;
                                await resolveReleased;
                                return { publicKey: migratedKey };
                            }
                        })
                    ]
                }
            });
            try {
                // Track unhandled rejections to detect the crash
                let unhandledRejection: unknown = undefined;
                const rejectionHandler = (reason: unknown) => {
                    unhandledRejection = reason;
                };
                process.on("unhandledRejection", rejectionHandler);

                // 4. The comment's own community loader is by key, and a loader by key never
                //    key-migrates (#605). The migration reaches the comment through a loader that
                //    asked for the name and shares the updating instance with it:
                //    a) byName starts the shared updating instance, pinned to oldPublicKey
                //    b) the comment loads its CommentIpfs and attaches to that instance
                //    c) the name resolves to a different key → key migration
                //    d) the instance emits update with communityIpfs=undefined
                //    e) the comment's handleUpdateEventFromCommunity should NOT crash
                const byName = await testPKC.createCommunity({ name: communityName, publicKey: oldPublicKey });
                const migrationError = new Promise<PKCError>((resolve) => {
                    byName.on("error", (err) => {
                        if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") resolve(err as PKCError);
                    });
                });
                await byName.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: byName,
                    predicate: async () => typeof byName.updatedAt === "number"
                });

                const comment = await testPKC.createComment({ cid: commentCid });
                await comment.update();

                // Wait for CommentIpfs to load
                await resolveWhenConditionIsTrue({
                    toUpdate: comment,
                    predicate: async () => !!comment.raw.comment
                });

                releaseResolve();
                expect((await migrationError).details.newPublicKey).to.equal(migratedKey);
                // Let a rejection from the comment's handler, if any, surface
                await new Promise((resolve) => setTimeout(resolve, 1000));

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
                await byName.stop();
            } finally {
                releaseResolve();
                await testPKC.destroy();
            }
        });
    });
});

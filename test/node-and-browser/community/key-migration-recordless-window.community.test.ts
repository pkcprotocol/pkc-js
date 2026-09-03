import { getAvailablePKCConfigsToTestAgainst, createMockNameResolver } from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";

import { describe, expect } from "vitest";

import type { PKCError } from "../../../dist/node/pkc-error.js";

// Repro for issue #332, the CI timeout in run 33714413774 (test-pkc-rpc job, PR #327):
// update.community.test.ts "performs key migration when name resolves to different public key"
// hung 160s at `await errorPromise` because its server-side subscription attached to the shared
// pkc._updatingCommunities entry AFTER a sibling subscription's migration had fired but BEFORE
// the migrated key's record landed.
//
// PR #289 fixed the late-joiner announcement, but its construction-time check
// (_setCommunityIpfsPropsFromUpdatingCommunitiesIfPossible) is gated on the tracked instance
// HOLDING a record, and the attach-time replay in fetchLatestCommunityOrSubscribeToEvent is
// gated the same way. A key migration clears the tracked instance's record and re-fetches, so a
// joiner arriving in that migrated-but-recordless window is never told about the migration: no
// error event, no cleared update, publicKey silently left stale until (and unless) the new
// key's record ever loads.
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`late joiner during the migrated-but-recordless window - ${config.name}`, () => {
        // Cannot run under RPC: the defect is in RemoteCommunity, which lives on the RPC server
        // under RPC, and the shared RPC test server strips client-supplied nameResolvers so the
        // mocked domain below cannot resolve there. Same reasoning as
        // key-migration-resubscribe.community.test.ts, which this file extends.
        itSkipIfRpc(`a joiner attaching while the migrated key's record has not loaded still sees the migration`, async () => {
            // A domain of this test's own so no other file can consume the migration first. It
            // resolves to a fresh signer that never publishes a record, holding the tracked
            // instance in the migrated-but-recordless state for the whole test.
            const communityName = "migration-recordless-window.bso";

            // Assigned right after the pkc is created, before anything resolves the name; the
            // resolver closure reads it lazily.
            let recordlessKey = "";
            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            resolveFunction: async ({ name }) =>
                                name === communityName && recordlessKey ? { publicKey: recordlessKey } : undefined
                        })
                    ]
                }
            });

            try {
                recordlessKey = (await testPKC.createSigner()).address;

                // First loader: its update loop resolves the name, detects the migration and
                // clears the tracked instance's data. The instance then keeps retrying the fetch
                // of recordlessKey's (nonexistent) record — the recordless window.
                const firstWrongKey = (await testPKC.createSigner()).address;
                const first = await testPKC.createCommunity({ name: communityName, publicKey: firstWrongKey });
                const firstMigrationObserved = new Promise<void>((resolve) => {
                    first.on("error", (err) => {
                        if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") resolve();
                    });
                });
                await first.update();
                await firstMigrationObserved;
                expect(first.publicKey).to.equal(recordlessKey);
                expect(first.updatedAt).to.be.undefined; // no record under recordlessKey, by design

                // Second loader joins now. The domain alias matches the migrated tracked
                // instance, which holds no record, so the #289 warm-start check never engages.
                const secondWrongKey = (await testPKC.createSigner()).address;
                const second = await testPKC.createCommunity({ name: communityName, publicKey: secondWrongKey });

                let migrationError: PKCError | undefined;
                const secondMigrationObserved = new Promise<void>((resolve) => {
                    second.on("error", (err) => {
                        if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") {
                            migrationError = err as PKCError;
                            resolve();
                        }
                    });
                });
                let clearedUpdateObserved = false;
                second.on("update", () => {
                    if (second.publicKey === recordlessKey && second.updatedAt === undefined) clearedUpdateObserved = true;
                });

                await second.update();

                // Same contract #289 pins for the record-holding case: a late joiner must observe
                // the migration. The wait is bounded because without the announcement the
                // recordless instance emits nothing at all, and an unbounded wait would only
                // convert this red into a suite timeout.
                const timedOut = Symbol("timed-out");
                const raceResult = await Promise.race([
                    secondMigrationObserved,
                    new Promise((resolve) => setTimeout(() => resolve(timedOut), 20_000))
                ]);
                expect(raceResult, "second loader never observed the key migration").to.not.equal(timedOut);

                expect(migrationError!.details.previousPublicKey).to.equal(secondWrongKey);
                expect(migrationError!.details.newPublicKey).to.equal(recordlessKey);
                expect(clearedUpdateObserved).to.be.true;
                expect(second.publicKey).to.equal(recordlessKey);
                expect(second.address).to.equal(communityName); // address is immutable
                expect(second.updatedAt).to.be.undefined; // cleared data, no record to load

                await second.stop();
                await first.stop();
            } finally {
                await testPKC.destroy();
            }
        });
    });
});

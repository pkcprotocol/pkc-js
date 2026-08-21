import signers from "../../fixtures/signers.js";

import {
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    createMockedCommunityIpns,
    createMockNameResolver
} from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";

import { describe, expect } from "vitest";

import type { PKCError } from "../../../dist/node/pkc-error.js";

// Regression guards for the two key-migration defects behind the CI failure in run 32105711724
// (test-pkc-rpc job) and issue #197. Both reproduced deterministically against the unfixed
// RemoteCommunity; both defects live server-side under RPC, which is why the tests are
// itSkipIfRpc (see the note above each test).
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`community.update() after a key migration - ${config.name}`, () => {
        // Cannot run under RPC: the defect was in RemoteCommunity, which lives on the RPC server. An
        // RPC client's stop()/update() unsubscribes and re-subscribes, and each subscribe builds a
        // fresh server-side instance that has not migrated yet, so the client never reaches this code
        // path. The RPC-level counterpart (the server's setSettings handler doing stop()+update() on
        // a migrated subscription) is covered in
        // test/node/rpc/community-update-subscription-churn.rpc.test.ts, which owns an in-process
        // PKCWsServer and can therefore configure name resolvers (the shared RPC test server strips
        // client-supplied nameResolvers).
        itSkipIfRpc(`update() after stop() re-attaches to the updating instance instead of throwing`, async () => {
            // A domain of this test's own, so a concurrent test file migrating one of the shared
            // domains (migrating.bso, migration-test.bso) cannot consume this migration first.
            const communityName = "migration-resubscribe.bso";
            const migratedKey = signers[0].address;

            const { communityAddress: ipnsKey } = await createMockedCommunityIpns({ name: communityName });

            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [createMockNameResolver({ records: new Map([[communityName, migratedKey]]) })]
                }
            });

            try {
                const community = await testPKC.createCommunity({ address: ipnsKey });
                await community.update();

                // Background resolution of the record's name detects the migration and flips publicKey
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.publicKey === migratedKey
                });
                expect(community.publicKey).to.equal(migratedKey);
                expect(community.address).to.equal(ipnsKey); // address is immutable

                await community.stop();

                // This is what the RPC server's setSettings handler does to every live subscription.
                // Before the fix this threw "should be defined at this stage" out of
                // fetchLatestCommunityOrSubscribeToEvent: the fresh updating instance was tracked
                // under the pre-migration address while the lookup used the post-migration
                // {publicKey, name}, which share no alias (#197).
                let migrationReannounced = false;
                community.on("error", (err) => {
                    if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") migrationReannounced = true;
                });
                await community.update();

                // Fresh-subscribe semantics: the re-created updating instance re-resolves and
                // re-announces the migration, then settles on the migrated key's record.
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.publicKey === migratedKey && typeof community.updatedAt === "number"
                });
                expect(migrationReannounced).to.be.true;
                expect(community.publicKey).to.equal(migratedKey);
                expect(community.address).to.equal(ipnsKey);

                await community.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        // Repro for the other two failures in the same CI run, update.community.test.ts:400 (timeout
        // waiting for ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY) and
        // publickey-fallback.community.test.ts:202 (`expected undefined to equal true` on
        // nameResolved). pkc._updatingCommunities is keyed by alias, so the domain matches an
        // instance that a previous loader already migrated. The migration fires exactly once on that
        // shared instance; before the fix a later joiner warm-started from its finished state with no
        // error event and no nameResolved. In CI the two loaders were two RPC clients sharing the
        // server's pkc; here they are two instances on one pkc, which is the same registry.
        itSkipIfRpc(`a second loader of a migrated domain still sees the migration`, async () => {
            const communityName = "migration-shared.bso";
            const migratedKey = signers[0].address;

            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [createMockNameResolver({ records: new Map([[communityName, migratedKey]]) })]
                }
            });

            try {
                // First loader: migrates the shared updating instance to migratedKey
                const firstWrongKey = (await testPKC.createSigner()).address;
                const first = await testPKC.createCommunity({ name: communityName, publicKey: firstWrongKey });
                await first.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: first,
                    predicate: async () => typeof first.updatedAt === "number"
                });
                expect(first.publicKey).to.equal(migratedKey);
                expect(first.nameResolved).to.equal(true);

                // Second loader joins while the first is still updating, so it finds the tracked
                // instance by the domain alias. It must observe the same sequence a first loader
                // does: the migration error, the cleared update, then the migrated record.
                const secondWrongKey = (await testPKC.createSigner()).address;
                const second = await testPKC.createCommunity({ name: communityName, publicKey: secondWrongKey });

                // The announcement is deferred to update() precisely because listeners attach here,
                // after createCommunity() returns
                let migrationError: PKCError | undefined;
                second.on("error", (err) => {
                    if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") migrationError = err as PKCError;
                });
                let clearedUpdateObserved = false;
                second.on("update", () => {
                    if (second.publicKey === migratedKey && second.updatedAt === undefined) clearedUpdateObserved = true;
                });

                await second.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: second,
                    predicate: async () => typeof second.updatedAt === "number"
                });

                expect(second.publicKey).to.equal(migratedKey);
                expect(second.address).to.equal(communityName);
                // What publickey-fallback.community.test.ts:202 asserts
                expect(second.nameResolved).to.equal(true);
                // What update.community.test.ts:400 waits for until it times out
                expect(migrationError).to.not.be.undefined;
                expect(migrationError!.details.previousPublicKey).to.equal(secondWrongKey);
                expect(migrationError!.details.newPublicKey).to.equal(migratedKey);
                expect(clearedUpdateObserved).to.be.true;

                await second.stop();
                await first.stop();
            } finally {
                await testPKC.destroy();
            }
        });
    });
});

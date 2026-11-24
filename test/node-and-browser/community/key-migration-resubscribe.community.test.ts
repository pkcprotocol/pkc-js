import signers from "../../fixtures/signers.js";

import {
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    createMockedCommunityIpns,
    createMockNameResolver
} from "../../../dist/node/test/test-util.js";
import { findUpdatingCommunity, refreshTrackedCommunityAliases } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
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
                // A loader by key never key-migrates on its own (#605), so the migrated key-addressed
                // instance this regression needs comes from sharing: a sibling that asked for the name
                // migrates the shared updating instance, and the by-key loader mirrors it.
                const sibling = await testPKC.createCommunity({ name: communityName, publicKey: ipnsKey });
                await sibling.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: sibling,
                    predicate: async () => sibling.publicKey === migratedKey
                });

                const community = await testPKC.createCommunity({ address: ipnsKey });
                await community.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.publicKey === migratedKey
                });
                expect(community.address).to.equal(ipnsKey); // address is immutable

                await community.stop();
                await sibling.stop();

                // This is what the RPC server's setSettings handler does to every live subscription.
                // Before the fix this threw "should be defined at this stage" out of
                // fetchLatestCommunityOrSubscribeToEvent: the fresh updating instance was tracked
                // under the pre-migration address while the lookup used the post-migration
                // {publicKey, name}, which share no alias (#197).
                await community.update();

                // With the sibling gone the re-created updating instance is this loader's own, addressed
                // by key: it loads the key's record, finds the name claim contradicted, and stays there.
                // The loader's way back from the sibling's key is announced like a migration; the test
                // below records that.
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () =>
                        community.publicKey === ipnsKey && typeof community.updatedAt === "number" && community.nameResolved === false
                });
                expect(community.address).to.equal(ipnsKey);

                await community.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        // Records what a by-key loader does today when it shares an updating instance with a loader
        // that asked for the name. It never migrates on its own (#605), but it mirrors the shared
        // instance, so the sibling's migration moves it too. Once it resubscribes alone its own
        // updating instance is addressed by key, and it comes back. That return is announced with
        // ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY although no name resolved to its key.
        // Both halves are the sharing case open in #450: a change there should update this test on
        // purpose rather than by accident.
        // Cannot run under RPC: the name resolver is configured on the client, and the shared RPC test
        // server strips client-supplied nameResolvers.
        itSkipIfRpc(`a by-key loader follows a by-name sibling's migration while they share, and returns to its key alone`, async () => {
            const communityName = "migration-shared-then-alone.bso";
            const migratedKey = signers[0].address;
            const { communityAddress: ipnsKey } = await createMockedCommunityIpns({ name: communityName });

            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [createMockNameResolver({ records: new Map([[communityName, migratedKey]]) })]
                }
            });

            const collectMigrationErrors = (community: { on: (event: "error", listener: (err: Error) => void) => unknown }) => {
                const errors: { previousPublicKey: string; newPublicKey: string }[] = [];
                community.on("error", (err) => {
                    const pkcError = err as PKCError;
                    if (pkcError.code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY")
                        errors.push({
                            previousPublicKey: pkcError.details.previousPublicKey,
                            newPublicKey: pkcError.details.newPublicKey
                        });
                });
                return errors;
            };

            try {
                const sibling = await testPKC.createCommunity({ name: communityName, publicKey: ipnsKey });
                await sibling.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: sibling,
                    predicate: async () => sibling.publicKey === migratedKey
                });

                // While sharing: the by-key loader is told about the sibling's migration and follows it
                const byKey = await testPKC.createCommunity({ address: ipnsKey });
                const errorsWhileSharing = collectMigrationErrors(byKey);
                await byKey.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: byKey,
                    predicate: async () => byKey.publicKey === migratedKey
                });
                expect(errorsWhileSharing).to.deep.equal([{ previousPublicKey: ipnsKey, newPublicKey: migratedKey }]);
                expect(byKey.address).to.equal(ipnsKey);

                await byKey.stop();
                await sibling.stop();

                // Alone: back on the key it asked for, with the name claim contradicted
                const errorsAlone = collectMigrationErrors(byKey);
                await byKey.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: byKey,
                    predicate: async () =>
                        byKey.publicKey === ipnsKey && typeof byKey.updatedAt === "number" && byKey.nameResolved === false
                });
                expect(errorsAlone).to.deep.equal([{ previousPublicKey: migratedKey, newPublicKey: ipnsKey }]);
                expect(byKey.address).to.equal(ipnsKey);
                expect(byKey.name).to.equal(communityName);

                await byKey.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        // The reverse of #605: a by-key loader whose record claims a name it does not hold stays on its
        // key, and must not be found under that name by a later loader that asks for the name. That
        // loader has to resolve the name itself and reach the key the name really points at.
        // Cannot run under RPC: the name resolver is configured on the client, and the shared RPC test
        // server strips client-supplied nameResolvers.
        itSkipIfRpc(`a by-key loader of a record claiming a name does not capture a later loader of that name`, async () => {
            const communityName = "migration-claimant-first.bso";
            // Both records claim the name; only the owner's key is what the name resolves to
            const { communityAddress: claimantKey } = await createMockedCommunityIpns({ name: communityName });
            const { communityAddress: ownerKey } = await createMockedCommunityIpns({ name: communityName });

            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [createMockNameResolver({ records: new Map([[communityName, ownerKey]]) })]
                }
            });

            try {
                const claimant = await testPKC.createCommunity({ address: claimantKey });
                await claimant.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: claimant,
                    predicate: async () => typeof claimant.updatedAt === "number" && claimant.nameResolved === false
                });
                expect(claimant.publicKey).to.equal(claimantKey);

                const byName = await testPKC.createCommunity({ address: communityName });
                await byName.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: byName,
                    // The first record the loader of the name is handed must already be the owner's; the
                    // verdict for the name follows it
                    predicate: async () => typeof byName.updatedAt === "number"
                });
                expect(byName.publicKey).to.equal(ownerKey);
                await resolveWhenConditionIsTrue({
                    toUpdate: byName,
                    predicate: async () => byName.nameResolved === true
                });
                expect(byName.publicKey).to.equal(ownerKey);
                // The claimant is untouched by the loader of the name
                expect(claimant.publicKey).to.equal(claimantKey);
                expect(claimant.nameResolved).to.equal(false);

                await byName.stop();
                await claimant.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        // The honest counterpart of the test above: once a by-key instance's name is proven, a loader of
        // that name shares the instance instead of opening a second one for the same community.
        // Cannot run under RPC: the name resolver is configured on the client, and the shared RPC test
        // server strips client-supplied nameResolvers.
        itSkipIfRpc(`a by-key loader whose record's name is proven is shared with a later loader of that name`, async () => {
            const communityName = "proven-name-shared.bso";
            const { communityAddress: key } = await createMockedCommunityIpns({ name: communityName });

            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [createMockNameResolver({ records: new Map([[communityName, key]]) })]
                }
            });

            try {
                const byKey = await testPKC.createCommunity({ address: key });
                await byKey.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: byKey,
                    predicate: async () => typeof byKey.updatedAt === "number" && byKey.nameResolved === true
                });

                const byName = await testPKC.createCommunity({ address: communityName });
                await byName.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: byName,
                    predicate: async () => typeof byName.updatedAt === "number" && byName.nameResolved === true
                });
                expect(byName.publicKey).to.equal(key);
                expect(testPKC._updatingCommunities.size()).to.equal(1);

                await byName.stop();
                await byKey.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        // A proven name stops being a lookup alias when its verdict turns false (the name was re-pointed).
        // The verdict is flipped by hand on the updating instance: driving a real re-resolve needs a new
        // record and an expired resolver cache, and what is under test is that the registry follows the
        // verdict, including out of its sticky alias history.
        // Cannot run under RPC: the name resolver is configured on the client, and the shared RPC test
        // server strips client-supplied nameResolvers.
        itSkipIfRpc(`a by-key updating instance stops being findable by its record's name once the name is contradicted`, async () => {
            const communityName = "proven-then-contradicted.bso";
            const { communityAddress: key } = await createMockedCommunityIpns({ name: communityName });

            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [createMockNameResolver({ records: new Map([[communityName, key]]) })]
                }
            });

            try {
                const byKey = await testPKC.createCommunity({ address: key });
                await byKey.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: byKey,
                    predicate: async () => typeof byKey.updatedAt === "number" && byKey.nameResolved === true
                });

                const updatingInstance = findUpdatingCommunity(testPKC, { name: communityName });
                expect(updatingInstance).to.not.be.undefined;
                expect(findUpdatingCommunity(testPKC, { publicKey: key })).to.equal(updatingInstance);

                updatingInstance!.nameResolved = false;
                refreshTrackedCommunityAliases(testPKC, updatingInstance!);
                expect(findUpdatingCommunity(testPKC, { name: communityName })).to.be.undefined;
                expect(findUpdatingCommunity(testPKC, { publicKey: key })).to.equal(updatingInstance);

                // A later sync must not bring the name back from the alias history
                refreshTrackedCommunityAliases(testPKC, updatingInstance!);
                expect(findUpdatingCommunity(testPKC, { name: communityName })).to.be.undefined;

                updatingInstance!.nameResolved = true;
                refreshTrackedCommunityAliases(testPKC, updatingInstance!);
                expect(findUpdatingCommunity(testPKC, { name: communityName })).to.equal(updatingInstance);

                await byKey.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        // The cost of the rule above. While a by-key instance's verdict is still pending its name is not a
        // lookup alias, so a loader of the name that arrives in that window opens its own updating
        // instance even when the name turns out to be honest. Both loaders must still end on the key with
        // the name proven.
        // Cannot run under RPC: the name resolver is configured on the client, and the shared RPC test
        // server strips client-supplied nameResolvers.
        itSkipIfRpc(`a loader of a name that arrives while a by-key instance's verdict is pending still loads the community`, async () => {
            const communityName = "pending-verdict.bso";
            const { communityAddress: key } = await createMockedCommunityIpns({ name: communityName });

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
                                return { publicKey: key };
                            }
                        })
                    ]
                }
            });

            try {
                const byKey = await testPKC.createCommunity({ address: key });
                await byKey.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: byKey,
                    predicate: async () => typeof byKey.updatedAt === "number"
                });
                expect(byKey.nameResolved).to.be.undefined;
                expect(findUpdatingCommunity(testPKC, { name: communityName })).to.be.undefined;

                const byName = await testPKC.createCommunity({ address: communityName });
                await byName.update();
                releaseResolve();

                await resolveWhenConditionIsTrue({
                    toUpdate: byName,
                    predicate: async () => typeof byName.updatedAt === "number" && byName.nameResolved === true
                });
                await resolveWhenConditionIsTrue({
                    toUpdate: byKey,
                    predicate: async () => byKey.nameResolved === true
                });
                expect(byName.publicKey).to.equal(key);
                expect(byKey.publicKey).to.equal(key);
                // Two updating instances for one community: the by-key one and the one the loader of the
                // name opened while the verdict was pending
                expect(testPKC._updatingCommunities.size()).to.equal(2);

                await byName.stop();
                await byKey.stop();
                expect(testPKC._updatingCommunities.size()).to.equal(0);
            } finally {
                releaseResolve();
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
            // Both loaders are by name, so the migrated key's record must claim the name or each
            // loader refuses it and never gets an updatedAt
            const { communityAddress: migratedKey } = await createMockedCommunityIpns({ name: communityName });

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
                // No record exists under firstWrongKey (a fresh signer), so updatedAt can only come
                // from the migrated key's record; the publicKey check makes that explicit.
                await resolveWhenConditionIsTrue({
                    toUpdate: first,
                    predicate: async () => first.publicKey === migratedKey && typeof first.updatedAt === "number"
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

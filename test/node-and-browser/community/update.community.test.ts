import signers from "../../fixtures/signers.js";

import {
    publishRandomPost,
    getAvailablePKCConfigsToTestAgainst,
    isPKCFetchingUsingGateways,
    createNewIpns,
    resolveWhenConditionIsTrue,
    itSkipIfRpc,
    createMockedCommunityIpns,
    publishCommunityRecordWithExtraProp,
    createMockNameResolver
} from "../../../dist/node/test/test-util.js";
import { convertBase58IpnsNameToBase36Cid } from "../../../dist/node/signer/util.js";

import * as remeda from "remeda";
import { _signJson } from "../../../dist/node/signer/signatures.js";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

const nameCommunitySigner = signers[3];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent("community.update (remote) - " + config.name, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        // Cannot run under RPC: test spies on name.resolve/fetch which happen server-side, not observable from the client
        itSkipIfRpc("calling update() on many instances of the same community resolves IPNS only once", async () => {
            const localPKC = await config.pkcInstancePromise();
            const randomSub = await createMockedCommunityIpns({});
            let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
            let nameResolveSpy: ReturnType<typeof vi.spyOn> | undefined;
            try {
                const usesGateways = isPKCFetchingUsingGateways(localPKC);
                const isRemoteIpfsGatewayConfig = isPKCFetchingUsingGateways(localPKC);
                const shouldMockFetchForIpns = isRemoteIpfsGatewayConfig && typeof globalThis.fetch === "function";

                const targetAddressForGatewayIpnsUrl = convertBase58IpnsNameToBase36Cid(randomSub.communityAddress);
                const stressCount = 100;

                if (!usesGateways) {
                    const p2pClient =
                        Object.keys(localPKC.clients.kuboRpcClients).length > 0
                            ? Object.values(localPKC.clients.kuboRpcClients)[0]._client
                            : Object.keys(localPKC.clients.libp2pJsClients).length > 0
                              ? Object.values(localPKC.clients.libp2pJsClients)[0].heliaWithKuboRpcClientFunctions
                              : undefined;
                    if (!p2pClient?.name?.resolve) {
                        throw new Error("Expected p2p client like kubo or helia RPC client with name.resolve for this test");
                    }
                    nameResolveSpy = vi.spyOn(p2pClient.name, "resolve");
                } else if (shouldMockFetchForIpns) {
                    fetchSpy = vi.spyOn(globalThis, "fetch");
                }

                const subInstances = await Promise.all(
                    new Array(stressCount).fill(null).map(async () => {
                        const subInstance = await localPKC.createCommunity({ address: randomSub.communityAddress });
                        return subInstance;
                    })
                );

                expect(localPKC._updatingCommunities.size()).to.equal(0);

                await Promise.all(subInstances.map((community) => community.update()));
                await Promise.all(
                    subInstances.map((community) =>
                        resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" })
                    )
                );

                const resolveCallsCount = fetchSpy
                    ? fetchSpy.mock.calls.filter(([input]: [unknown]) => {
                          const url = typeof input === "string" ? input : (input as { url?: string })?.url;
                          return typeof url === "string" && url.includes("/ipns/" + targetAddressForGatewayIpnsUrl);
                      }).length
                    : nameResolveSpy?.mock.calls.length;

                expect(resolveCallsCount).to.equal(
                    1,
                    "Updating many community instances with the same address should only resolve IPNS once"
                );
            } finally {
                if (nameResolveSpy) nameResolveSpy.mockRestore();
                if (fetchSpy) fetchSpy.mockRestore();
                await localPKC.destroy();
            }
        });

        it(`community.update() works correctly with community.address as domain`, async () => {
            const community = await pkc.getCommunity({ address: "plebbit.bso" }); // 'plebbit.eth' is part of test-server.js
            expect(community.address).to.equal("plebbit.bso");
            const oldUpdatedAt = remeda.clone(community.updatedAt);
            await community.update();
            await publishRandomPost({ communityAddress: community.address, pkc: pkc }); // Invoke an update
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => oldUpdatedAt !== community.updatedAt });
            expect(oldUpdatedAt).to.not.equal(community.updatedAt);
            expect(community.address).to.equal("plebbit.bso");
            await community.stop();
        });

        // Scenario B: {address: "12D3Koo..."} loads record with name field — accept it, set name from record, keep address as IPNS key
        // On subsequent update loops, the record's name is resolved in background to verify the domain claim
        it(`community.update() accepts record and sets name when loaded by raw IPNS key, then resolves name in background`, async () => {
            const loadedCommunity = await pkc.createCommunity({ address: nameCommunitySigner.address });
            await loadedCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedCommunity,
                predicate: async () => typeof loadedCommunity.updatedAt === "number"
            });
            // address stays as the raw IPNS key (immutable)
            expect(loadedCommunity.address).to.equal(nameCommunitySigner.address);
            // name is set from the record's name field
            expect(loadedCommunity.name).to.equal("plebbit.bso");
            // publicKey is set from the record's signature
            expect(loadedCommunity.publicKey).to.equal(nameCommunitySigner.address);

            // On subsequent update loops, the name "plebbit.bso" is resolved in background.
            // The default mock resolver maps "plebbit.bso" → nameCommunitySigner.address (same key),
            // so nameResolved should eventually become true — and that change emits an "update" event.
            await resolveWhenConditionIsTrue({
                toUpdate: loadedCommunity,
                predicate: async () => loadedCommunity.nameResolved === true
            });
            expect(loadedCommunity.nameResolved).to.equal(true);
            expect(loadedCommunity.address).to.equal(nameCommunitySigner.address);
            await loadedCommunity.stop();
        });

        // Scenario B + name resolves to different key: triggers key migration
        it(`community loaded by raw IPNS key triggers key migration when record's name resolves to different key`, async () => {
            // "migration-test.bso" is in defaultMockResolverRecords → signers[0].address,
            // which differs from the mocked record's signer → triggers key migration
            const { communityAddress: ipnsKey } = await createMockedCommunityIpns({ name: "migration-test.bso" });
            const differentKey = signers[0].address;

            const testPKC = await config.pkcInstancePromise();

            try {
                const community = await testPKC.createCommunity({ address: ipnsKey });
                const errorPromise = new Promise<PKCError>((resolve) => {
                    community.on("error", (err) => {
                        if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") {
                            resolve(err as PKCError);
                        }
                    });
                });
                const clearedUpdatePromise = new Promise<void>((resolve) => {
                    community.on("update", () => {
                        if (community.publicKey === differentKey && community.updatedAt === undefined) {
                            resolve();
                        }
                    });
                });

                await community.update();

                // First update: record loaded, name set from record
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => typeof community.updatedAt === "number"
                });
                expect(community.name).to.equal("migration-test.bso");

                const error = await errorPromise;
                expect(error.details.previousPublicKey).to.equal(ipnsKey);
                expect(error.details.newPublicKey).to.equal(differentKey);

                await clearedUpdatePromise;
                // Data should be cleared
                expect(community.updatedAt).to.be.undefined;
                expect(community.raw.communityIpfs).to.be.undefined;
                // publicKey updated to new key
                expect(community.publicKey).to.equal(differentKey);
                // address stays immutable
                expect(community.address).to.equal(ipnsKey);

                await community.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        // Scenario B + name fails to resolve: nameResolved becomes false
        it(`community loaded by raw IPNS key sets nameResolved=false when record's name cannot be resolved`, async () => {
            const { communityAddress: ipnsKey } = await createMockedCommunityIpns({ name: "unresolvable-name.bso" });

            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            // "unresolvable-name.bso" returns undefined (no TXT record)
                            records: new Map([["unresolvable-name.bso", undefined]])
                        })
                    ]
                }
            });

            try {
                const community = await testPKC.createCommunity({ address: ipnsKey });

                let keyMigrationErrorEmitted = false;
                community.on("error", (err) => {
                    if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") {
                        keyMigrationErrorEmitted = true;
                    }
                });

                await community.update();

                // First update: record loaded
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => typeof community.updatedAt === "number"
                });
                expect(community.name).to.equal("unresolvable-name.bso");

                // On subsequent update loop, background resolution of "unresolvable-name.bso"
                // returns null — nameResolved should become false, which emits an "update" event.
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.nameResolved === false
                });
                expect(community.nameResolved).to.equal(false);
                // No key migration error — just a name that doesn't resolve
                expect(keyMigrationErrorEmitted).to.be.false;
                // Data should still be intact
                expect(community.updatedAt).to.be.a("number");
                expect(community.address).to.equal(ipnsKey);

                await community.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        it.sequential(`community.update emits error if signature of community is invalid`, async () => {
            // should emit an error and keep retrying

            // Publish a valid record signed with ipnsObj.signer first, then corrupt a signed field.
            // We cannot just copy signers[0]'s record because its publicKey would mismatch the IPNS address,
            // causing ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED instead of ERR_COMMUNITY_SIGNATURE_IS_INVALID.
            const { communityRecord, ipnsObj } = await publishCommunityRecordWithExtraProp();
            (communityRecord as Record<string, unknown>).updatedAt = (communityRecord.updatedAt || 0) + 9999; // corrupt a signed field
            await ipnsObj.publishToIpns(JSON.stringify(communityRecord));
            const tempCommunity = await pkc.createCommunity({ address: ipnsObj.signer.address });

            const errorPromise = new Promise<void>((resolve) => {
                tempCommunity.once("error", (err: PKCError | Error) => {
                    const pErr = err as PKCError;
                    if (isPKCFetchingUsingGateways(pkc)) {
                        expect(pErr.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                        for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways))
                            expect((pErr.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal(
                                "ERR_COMMUNITY_SIGNATURE_IS_INVALID"
                            );
                    } else {
                        expect(pErr.code).to.equal("ERR_COMMUNITY_SIGNATURE_IS_INVALID");
                    }
                    resolve();
                });
            });

            await tempCommunity.update();
            await errorPromise;
            await tempCommunity.stop();
            await ipnsObj.pkc.destroy();
        });

        it(`community.update emits error if schema of community is invalid `, async () => {
            const rawCommunityJson = (await pkc.getCommunity({ address: signers[0].address })).raw.communityIpfs!;
            (rawCommunityJson as Record<string, unknown>).lastPostCid = 12345; // This will make schema invalid

            const ipnsObj = await createNewIpns();
            await ipnsObj.publishToIpns(JSON.stringify(rawCommunityJson));
            const tempCommunity = await pkc.createCommunity({ address: ipnsObj.signer.address });
            const errorPromise = new Promise<void>((resolve) => {
                tempCommunity.once("error", (err: PKCError | Error) => {
                    const pErr = err as PKCError;
                    if (isPKCFetchingUsingGateways(pkc)) {
                        expect(pErr.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                        for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways))
                            expect((pErr.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal(
                                "ERR_INVALID_COMMUNITY_IPFS_SCHEMA"
                            );
                    } else {
                        expect(pErr.code).to.equal("ERR_INVALID_COMMUNITY_IPFS_SCHEMA");
                    }
                    resolve();
                });
            });

            await tempCommunity.update();
            await errorPromise;

            await tempCommunity.stop();
            await ipnsObj.pkc.destroy();
        });

        it(`community.update emits error if community record is invalid json`, async () => {
            const ipnsObj = await createNewIpns();
            await ipnsObj.publishToIpns("<html>"); // invalid json
            const tempCommunity = await pkc.createCommunity({ address: ipnsObj.signer.address });

            const errorPromise = new Promise<void>((resolve) => {
                tempCommunity.once("error", (err: PKCError | Error) => {
                    const pErr = err as PKCError;
                    if (isPKCFetchingUsingGateways(pkc)) {
                        // we're using gateways to fetch
                        expect(pErr.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                        for (const gatewayUrl of Object.keys(tempCommunity.clients.ipfsGateways)) {
                            expect((pErr.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal("ERR_INVALID_JSON");
                        }
                    } else {
                        expect(pErr.code).to.equal("ERR_INVALID_JSON");
                    }
                    resolve();
                });
            });
            await tempCommunity.update();
            await errorPromise;

            await tempCommunity.stop();
            await ipnsObj.pkc.destroy();
        });

        it(`community.update emits error and keeps retrying if address is name and name address has no community-address text record`, async () => {
            const community = await pkc.createCommunity({ address: "this-sub-does-not-exist.bso" });
            // Should emit an error and keep on retrying in the next update loop
            let errorCount = 0;
            let resolveErrorPromise: () => void;
            const errorPromise = new Promise<void>((resolve) => {
                resolveErrorPromise = resolve;
            });
            const errorListener = (err: PKCError | Error) => {
                expect((err as PKCError).code).to.equal("ERR_DOMAIN_TXT_RECORD_NOT_FOUND");
                expect(community.updatingState).to.equal("waiting-retry");
                errorCount++;
                if (errorCount === 3) resolveErrorPromise();
            };
            community.on("error", errorListener);
            await community.update();
            await errorPromise;
            await community.stop();
            community.removeListener("error", errorListener);
        });

        it(`community.stop() stops community updates`, async () => {
            const remotePKC = await config.pkcInstancePromise();
            const community = await remotePKC.createCommunity({ address: "plebbit.bso" }); // 'plebbit.eth' is part of test-server.js
            await community.update();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            await community.stop();
            let updatedHasBeenCalled = false;

            community.on("update", () => {
                updatedHasBeenCalled = true;
            });

            (community as unknown as Record<string, Function>).updateOnce = (
                community as unknown as Record<string, Function>
            )._setUpdatingState = async () => {
                updatedHasBeenCalled = true;
            };
            await new Promise((resolve) => setTimeout(resolve, remotePKC.updateInterval * 2));
            expect(updatedHasBeenCalled).to.be.false;
            await remotePKC.destroy();
        });

        it(`community.update() is working as expected after calling community.stop()`, async () => {
            const community = await pkc.createCommunity({ address: signers[0].address });

            await community.update();
            await new Promise((resolve) => community.once("update", resolve));

            await community.stop();

            await community.update();

            await publishRandomPost({ communityAddress: community.address, pkc: pkc });
            await new Promise((resolve) => community.once("update", resolve));
            await community.stop();
        });

        // Scenario A: {address: domain, publicKey: pkA} where domain resolves to pkB (key migration)
        it(`community.update() performs key migration when name resolves to different public key`, async () => {
            // "migrating.bso" is in defaultMockResolverRecords → signers[0].address,
            // which differs from the mocked record's signer → triggers key migration
            const { communityAddress: oldPublicKey } = await createMockedCommunityIpns({});
            const newPublicKey = signers[0].address; // domain will resolve to this different key

            const testPKC = await config.pkcInstancePromise();

            try {
                const community = await testPKC.createCommunity({ address: "migrating.bso", publicKey: oldPublicKey });
                expect(community.address).to.equal("migrating.bso");
                expect(community.publicKey).to.equal(oldPublicKey);

                const errorPromise = new Promise<PKCError>((resolve) => {
                    community.on("error", (err) => {
                        if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") {
                            resolve(err as PKCError);
                        }
                    });
                });

                // Wait for an update event where data has been cleared (key migration)
                const clearedUpdatePromise = new Promise<void>((resolve) => {
                    community.on("update", () => {
                        if (community.publicKey === newPublicKey && community.updatedAt === undefined) {
                            resolve();
                        }
                    });
                });

                await community.update();

                // Should emit ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY
                const error = await errorPromise;
                expect(error.details.previousPublicKey).to.equal(oldPublicKey);
                expect(error.details.newPublicKey).to.equal(newPublicKey);

                // Should emit update with cleared data
                await clearedUpdatePromise;
                expect(community.updatedAt).to.be.undefined;
                expect(community.title).to.be.undefined;
                expect(community.signature).to.be.undefined;
                expect(community.raw.communityIpfs).to.be.undefined;
                expect(community.updateCid).to.be.undefined;

                // address stays immutable
                expect(community.address).to.equal("migrating.bso");
                // publicKey updated to new key
                expect(community.publicKey).to.equal(newPublicKey);
                // nameResolved is true since domain resolved correctly to the new key
                expect(community.nameResolved).to.equal(true);
                // IPNS routing props updated
                expect(community.ipnsName).to.equal(newPublicKey);

                // Eventually loads new record from the new public key
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => typeof community.updatedAt === "number"
                });
                expect(community.publicKey).to.equal(newPublicKey);
                expect(community.address).to.equal("migrating.bso");

                await community.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        // Scenario C: {address: domain} where record has name: "other.eth" (different name)
        it(`community.update() rejects record when record name differs from loaded domain address`, async () => {
            // "wrong-name.bso" is in defaultMockResolverRecords → signers[3].address
            // signers[3]'s record has name: "plebbit.bso", so "wrong-name.bso" ≠ "plebbit.bso" → rejection
            const testPKC = await config.pkcInstancePromise();

            try {
                const community = await testPKC.createCommunity({ address: "wrong-name.bso" });
                const errorPromise = new Promise<PKCError>((resolve) => community.once("error", resolve as (err: Error) => void));

                await community.update();
                const error = await errorPromise;

                if (isPKCFetchingUsingGateways(testPKC)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                    for (const gatewayUrl of Object.keys(testPKC.clients.ipfsGateways)) {
                        expect((error.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal(
                            "ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED"
                        );
                    }
                } else {
                    expect(error.code).to.equal("ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED");
                }
                // Record should not be accepted
                expect(community.updatedAt).to.be.undefined;
                expect(community.address).to.equal("wrong-name.bso");

                await community.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        it(`community.update() falls back to publicKey when name resolution fails and sets nameResolved=false`, async () => {
            // Default mock resolver can't resolve "unresolvable.bso" (not in default records) → falls back to publicKey
            const { communityAddress: publicKey } = await createMockedCommunityIpns({});

            const testPKC = await config.pkcInstancePromise();

            try {
                const community = await testPKC.createCommunity({ address: "unresolvable.bso", publicKey });

                // Should not emit the key migration error
                let keyMigrationErrorEmitted = false;
                community.on("error", (err) => {
                    if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") {
                        keyMigrationErrorEmitted = true;
                    }
                });

                await community.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => typeof community.updatedAt === "number"
                });

                // Record loaded via publicKey fallback
                expect(community.updatedAt).to.be.a("number");
                expect(community.address).to.equal("unresolvable.bso");
                expect(community.publicKey).to.equal(publicKey);
                // Name could not be resolved (null returned), and community.name is "unresolvable.bso",
                // so nameResolved should become false — background resolution emits "update"
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.nameResolved === false
                });
                expect(community.nameResolved).to.equal(false);
                expect(keyMigrationErrorEmitted).to.be.false;

                await community.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        // _clearDataForKeyMigration unit test
        itSkipIfRpc(`_clearDataForKeyMigration clears all data fields and updates key`, async () => {
            // Cannot run in RPC because we access internal methods directly
            const community = await pkc.createCommunity({ address: signers[0].address });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number"
            });
            await community.stop();

            // Verify data is populated before clearing
            expect(community.updatedAt).to.be.a("number");
            expect(community.signature).to.not.be.undefined;

            const originalAddress = community.address;
            const newKey = signers[1].address;

            community._clearDataForKeyMigration(newKey);

            // All data fields should be cleared
            expect(community.updatedAt).to.be.undefined;
            expect(community.title).to.be.undefined;
            expect(community.description).to.be.undefined;
            expect(community.createdAt).to.be.undefined;
            expect(community.signature).to.be.undefined;
            expect(community.encryption).to.be.undefined;
            expect(community.pubsubTopic).to.be.undefined;
            expect(community.challenges).to.be.undefined;
            expect(community.roles).to.be.undefined;
            expect(community.rules).to.be.undefined;
            expect(community.features).to.be.undefined;
            expect(community.suggested).to.be.undefined;
            expect(community.flairs).to.be.undefined;
            expect(community.postUpdates).to.be.undefined;
            expect(community.statsCid).to.be.undefined;
            expect(community.lastPostCid).to.be.undefined;
            expect(community.lastCommentCid).to.be.undefined;
            expect(community.protocolVersion).to.be.undefined;
            expect(community.raw.communityIpfs).to.be.undefined;
            expect(community.updateCid).to.be.undefined;

            // Address stays unchanged (immutable)
            expect(community.address).to.equal(originalAddress);

            // Key updated
            expect(community.publicKey).to.equal(newKey);
            expect(community.ipnsName).to.equal(newKey);

            // Calling twice doesn't crash
            community._clearDataForKeyMigration(newKey);
            expect(community.address).to.equal(originalAddress);
            expect(community.publicKey).to.equal(newKey);
        });

        it(`community.update() emits an error if community record is over 1mb`, async () => {
            // pkc-js will emit an error once, mark the invalid cid, and never retry
            const twoMbObject = { testString: "x".repeat(2 * 1024 * 1024) }; //2mb

            const ipnsObj = await createNewIpns();

            await ipnsObj.publishToIpns(JSON.stringify(twoMbObject));

            const tempCommunity = await pkc.createCommunity({ address: ipnsObj.signer.address });

            const errorPromise = new Promise<PKCError>((resolve) => tempCommunity.once("error", resolve as (err: Error) => void));
            await tempCommunity.update();
            const err = await errorPromise;
            await tempCommunity.stop();

            if (isPKCFetchingUsingGateways(pkc)) {
                // we're using gateways to fetch
                expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                for (const gatewayUrl of Object.keys(tempCommunity.clients.ipfsGateways))
                    expect((err.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
            } else expect(err.code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
            await ipnsObj.pkc.destroy();
        });

        // Verify that background name resolution emits "update" independently of communityIpfs changes
        it(`background name resolution emits update with nameResolved=true without a new communityIpfs record`, async () => {
            const community = await pkc.createCommunity({ address: nameCommunitySigner.address });
            await community.update();
            // Wait for the initial record to load
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number"
            });
            // Capture the record state — nameResolved may still be undefined (background resolution is async)
            const updatedAtBeforeNameResolved = community.updatedAt;
            const updateCidBeforeNameResolved = community.updateCid;

            // Wait for background resolution to set nameResolved=true via an "update" event
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => community.nameResolved === true
            });
            // The communityIpfs record should be unchanged — update was triggered solely by nameResolved
            expect(community.updatedAt).to.equal(updatedAtBeforeNameResolved);
            expect(community.updateCid).to.equal(updateCidBeforeNameResolved);
            expect(community.nameResolved).to.equal(true);
            expect(community.address).to.equal(nameCommunitySigner.address);
            await community.stop();
        });

        it(`background name resolution emits update with nameResolved=false without a new communityIpfs record`, async () => {
            const { communityAddress: ipnsKey } = await createMockedCommunityIpns({ name: "unresolvable-name-independent.bso" });

            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            records: new Map([["unresolvable-name-independent.bso", undefined]])
                        })
                    ]
                }
            });

            try {
                const community = await testPKC.createCommunity({ address: ipnsKey });
                await community.update();
                // Wait for the initial record to load
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => typeof community.updatedAt === "number"
                });
                expect(community.name).to.equal("unresolvable-name-independent.bso");
                // Capture the record state
                const updatedAtBeforeNameResolved = community.updatedAt;
                const updateCidBeforeNameResolved = community.updateCid;

                // Wait for background resolution to set nameResolved=false via an "update" event
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.nameResolved === false
                });
                // The communityIpfs record should be unchanged — update was triggered solely by nameResolved
                expect(community.updatedAt).to.equal(updatedAtBeforeNameResolved);
                expect(community.updateCid).to.equal(updateCidBeforeNameResolved);
                expect(community.nameResolved).to.equal(false);
                expect(community.address).to.equal(ipnsKey);
                await community.stop();
            } finally {
                await testPKC.destroy();
            }
        });

        it(`page comment author background resolution does not emit spurious update on community`, async () => {
            // Load a community that has pages with domain-author comments
            const community = await pkc.createCommunity({ address: signers[0].address });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => Boolean(community.posts?.pages?.hot?.comments?.length)
            });

            // Track whether nameResolved ever gets set on the community itself
            // (it shouldn't — signers[0].address is a B58 key, not a domain)
            let nameResolvedEverChanged = false;
            const onUpdate = () => {
                if (typeof community.nameResolved === "boolean") {
                    nameResolvedEverChanged = true;
                }
            };
            community.on("update", onUpdate);

            // Wait to let any pending background page author resolution settle
            await new Promise((resolve) => setTimeout(resolve, 2000));

            community.removeListener("update", onUpdate);
            await community.stop();

            // community.nameResolved should remain undefined (no community domain to resolve)
            expect(community.nameResolved).to.be.undefined;
            expect(nameResolvedEverChanged).to.be.false;
        });
    });
});

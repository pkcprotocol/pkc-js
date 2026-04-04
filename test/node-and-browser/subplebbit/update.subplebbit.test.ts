import signers from "../../fixtures/signers.js";

import {
    publishRandomPost,
    getAvailablePlebbitConfigsToTestAgainst,
    isPlebbitFetchingUsingGateways,
    createNewIpns,
    resolveWhenConditionIsTrue,
    itSkipIfRpc,
    createMockedSubplebbitIpns,
    publishSubplebbitRecordWithExtraProp,
    createMockNameResolver
} from "../../../dist/node/test/test-util.js";
import { convertBase58IpnsNameToBase36Cid } from "../../../dist/node/signer/util.js";

import * as remeda from "remeda";
import { _signJson } from "../../../dist/node/signer/signatures.js";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { PlebbitError } from "../../../dist/node/plebbit-error.js";

const nameSubplebbitSigner = signers[3];

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent("subplebbit.update (remote) - " + config.name, async () => {
        let plebbit: PlebbitType;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        // Cannot run under RPC: test spies on name.resolve/fetch which happen server-side, not observable from the client
        itSkipIfRpc("calling update() on many instances of the same subplebbit resolves IPNS only once", async () => {
            const localPlebbit = await config.plebbitInstancePromise();
            const randomSub = await createMockedSubplebbitIpns({});
            let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
            let nameResolveSpy: ReturnType<typeof vi.spyOn> | undefined;
            try {
                const usesGateways = isPlebbitFetchingUsingGateways(localPlebbit);
                const isRemoteIpfsGatewayConfig = isPlebbitFetchingUsingGateways(localPlebbit);
                const shouldMockFetchForIpns = isRemoteIpfsGatewayConfig && typeof globalThis.fetch === "function";

                const targetAddressForGatewayIpnsUrl = convertBase58IpnsNameToBase36Cid(randomSub.communityAddress);
                const stressCount = 100;

                if (!usesGateways) {
                    const p2pClient =
                        Object.keys(localPlebbit.clients.kuboRpcClients).length > 0
                            ? Object.values(localPlebbit.clients.kuboRpcClients)[0]._client
                            : Object.keys(localPlebbit.clients.libp2pJsClients).length > 0
                              ? Object.values(localPlebbit.clients.libp2pJsClients)[0].heliaWithKuboRpcClientFunctions
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
                        const subInstance = await localPlebbit.createSubplebbit({ address: randomSub.communityAddress });
                        return subInstance;
                    })
                );

                expect(localPlebbit._updatingSubplebbits.size()).to.equal(0);

                await Promise.all(subInstances.map((sub) => sub.update()));
                await Promise.all(
                    subInstances.map((sub) =>
                        resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" })
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
                    "Updating many subplebbit instances with the same address should only resolve IPNS once"
                );
            } finally {
                if (nameResolveSpy) nameResolveSpy.mockRestore();
                if (fetchSpy) fetchSpy.mockRestore();
                await localPlebbit.destroy();
            }
        });

        it(`subplebbit.update() works correctly with subplebbit.address as domain`, async () => {
            const subplebbit = await plebbit.getSubplebbit({ address: "plebbit.bso" }); // 'plebbit.eth' is part of test-server.js
            expect(subplebbit.address).to.equal("plebbit.bso");
            const oldUpdatedAt = remeda.clone(subplebbit.updatedAt);
            await subplebbit.update();
            await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit }); // Invoke an update
            await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => oldUpdatedAt !== subplebbit.updatedAt });
            expect(oldUpdatedAt).to.not.equal(subplebbit.updatedAt);
            expect(subplebbit.address).to.equal("plebbit.bso");
            await subplebbit.stop();
        });

        // Scenario B: {address: "12D3Koo..."} loads record with name field — accept it, set name from record, keep address as IPNS key
        // On subsequent update loops, the record's name is resolved in background to verify the domain claim
        it(`subplebbit.update() accepts record and sets name when loaded by raw IPNS key, then resolves name in background`, async () => {
            const loadedSubplebbit = await plebbit.createSubplebbit({ address: nameSubplebbitSigner.address });
            await loadedSubplebbit.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedSubplebbit,
                predicate: async () => typeof loadedSubplebbit.updatedAt === "number"
            });
            // address stays as the raw IPNS key (immutable)
            expect(loadedSubplebbit.address).to.equal(nameSubplebbitSigner.address);
            // name is set from the record's name field
            expect(loadedSubplebbit.name).to.equal("plebbit.bso");
            // publicKey is set from the record's signature
            expect(loadedSubplebbit.publicKey).to.equal(nameSubplebbitSigner.address);

            // On subsequent update loops, the name "plebbit.bso" is resolved in background.
            // The default mock resolver maps "plebbit.bso" → nameSubplebbitSigner.address (same key),
            // so nameResolved should eventually become true — and that change emits an "update" event.
            await resolveWhenConditionIsTrue({
                toUpdate: loadedSubplebbit,
                predicate: async () => loadedSubplebbit.nameResolved === true
            });
            expect(loadedSubplebbit.nameResolved).to.equal(true);
            expect(loadedSubplebbit.address).to.equal(nameSubplebbitSigner.address);
            await loadedSubplebbit.stop();
        });

        // Scenario B + name resolves to different key: triggers key migration
        it(`subplebbit loaded by raw IPNS key triggers key migration when record's name resolves to different key`, async () => {
            // "migration-test.bso" is in defaultMockResolverRecords → signers[0].address,
            // which differs from the mocked record's signer → triggers key migration
            const { communityAddress: ipnsKey } = await createMockedSubplebbitIpns({ name: "migration-test.bso" });
            const differentKey = signers[0].address;

            const testPlebbit = await config.plebbitInstancePromise();

            try {
                const sub = await testPlebbit.createSubplebbit({ address: ipnsKey });
                const errorPromise = new Promise<PlebbitError>((resolve) => {
                    sub.on("error", (err) => {
                        if ((err as PlebbitError).code === "ERR_SUBPLEBBIT_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") {
                            resolve(err as PlebbitError);
                        }
                    });
                });
                const clearedUpdatePromise = new Promise<void>((resolve) => {
                    sub.on("update", () => {
                        if (sub.publicKey === differentKey && sub.updatedAt === undefined) {
                            resolve();
                        }
                    });
                });

                await sub.update();

                // First update: record loaded, name set from record
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => typeof sub.updatedAt === "number"
                });
                expect(sub.name).to.equal("migration-test.bso");

                const error = await errorPromise;
                expect(error.details.previousPublicKey).to.equal(ipnsKey);
                expect(error.details.newPublicKey).to.equal(differentKey);

                await clearedUpdatePromise;
                // Data should be cleared
                expect(sub.updatedAt).to.be.undefined;
                expect(sub.raw.subplebbitIpfs).to.be.undefined;
                // publicKey updated to new key
                expect(sub.publicKey).to.equal(differentKey);
                // address stays immutable
                expect(sub.address).to.equal(ipnsKey);

                await sub.stop();
            } finally {
                await testPlebbit.destroy();
            }
        });

        // Scenario B + name fails to resolve: nameResolved becomes false
        it(`subplebbit loaded by raw IPNS key sets nameResolved=false when record's name cannot be resolved`, async () => {
            const { communityAddress: ipnsKey } = await createMockedSubplebbitIpns({ name: "unresolvable-name.bso" });

            const testPlebbit = await config.plebbitInstancePromise({
                mockResolve: false,
                plebbitOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            // "unresolvable-name.bso" returns undefined (no TXT record)
                            records: new Map([["unresolvable-name.bso", undefined]])
                        })
                    ]
                }
            });

            try {
                const sub = await testPlebbit.createSubplebbit({ address: ipnsKey });

                let keyMigrationErrorEmitted = false;
                sub.on("error", (err) => {
                    if ((err as PlebbitError).code === "ERR_SUBPLEBBIT_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") {
                        keyMigrationErrorEmitted = true;
                    }
                });

                await sub.update();

                // First update: record loaded
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => typeof sub.updatedAt === "number"
                });
                expect(sub.name).to.equal("unresolvable-name.bso");

                // On subsequent update loop, background resolution of "unresolvable-name.bso"
                // returns null — nameResolved should become false, which emits an "update" event.
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => sub.nameResolved === false
                });
                expect(sub.nameResolved).to.equal(false);
                // No key migration error — just a name that doesn't resolve
                expect(keyMigrationErrorEmitted).to.be.false;
                // Data should still be intact
                expect(sub.updatedAt).to.be.a("number");
                expect(sub.address).to.equal(ipnsKey);

                await sub.stop();
            } finally {
                await testPlebbit.destroy();
            }
        });

        it.sequential(`subplebbit.update emits error if signature of subplebbit is invalid`, async () => {
            // should emit an error and keep retrying

            // Publish a valid record signed with ipnsObj.signer first, then corrupt a signed field.
            // We cannot just copy signers[0]'s record because its publicKey would mismatch the IPNS address,
            // causing ERR_THE_SUBPLEBBIT_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED instead of ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID.
            const { subplebbitRecord, ipnsObj } = await publishSubplebbitRecordWithExtraProp();
            (subplebbitRecord as Record<string, unknown>).updatedAt = (subplebbitRecord.updatedAt || 0) + 9999; // corrupt a signed field
            await ipnsObj.publishToIpns(JSON.stringify(subplebbitRecord));
            const tempSubplebbit = await plebbit.createSubplebbit({ address: ipnsObj.signer.address });

            const errorPromise = new Promise<void>((resolve) => {
                tempSubplebbit.once("error", (err: PlebbitError | Error) => {
                    const pErr = err as PlebbitError;
                    if (isPlebbitFetchingUsingGateways(plebbit)) {
                        expect(pErr.code).to.equal("ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS");
                        for (const gatewayUrl of Object.keys(plebbit.clients.ipfsGateways))
                            expect((pErr.details.gatewayToError[gatewayUrl] as PlebbitError).code).to.equal(
                                "ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID"
                            );
                    } else {
                        expect(pErr.code).to.equal("ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID");
                    }
                    resolve();
                });
            });

            await tempSubplebbit.update();
            await errorPromise;
            await tempSubplebbit.stop();
            await ipnsObj.plebbit.destroy();
        });

        it(`subplebbit.update emits error if schema of subplebbit is invalid `, async () => {
            const rawSubplebbitJson = (await plebbit.getSubplebbit({ address: signers[0].address })).raw.subplebbitIpfs!;
            (rawSubplebbitJson as Record<string, unknown>).lastPostCid = 12345; // This will make schema invalid

            const ipnsObj = await createNewIpns();
            await ipnsObj.publishToIpns(JSON.stringify(rawSubplebbitJson));
            const tempSubplebbit = await plebbit.createSubplebbit({ address: ipnsObj.signer.address });
            const errorPromise = new Promise<void>((resolve) => {
                tempSubplebbit.once("error", (err: PlebbitError | Error) => {
                    const pErr = err as PlebbitError;
                    if (isPlebbitFetchingUsingGateways(plebbit)) {
                        expect(pErr.code).to.equal("ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS");
                        for (const gatewayUrl of Object.keys(plebbit.clients.ipfsGateways))
                            expect((pErr.details.gatewayToError[gatewayUrl] as PlebbitError).code).to.equal(
                                "ERR_INVALID_SUBPLEBBIT_IPFS_SCHEMA"
                            );
                    } else {
                        expect(pErr.code).to.equal("ERR_INVALID_SUBPLEBBIT_IPFS_SCHEMA");
                    }
                    resolve();
                });
            });

            await tempSubplebbit.update();
            await errorPromise;

            await tempSubplebbit.stop();
            await ipnsObj.plebbit.destroy();
        });

        it(`subplebbit.update emits error if subplebbit record is invalid json`, async () => {
            const ipnsObj = await createNewIpns();
            await ipnsObj.publishToIpns("<html>"); // invalid json
            const tempSubplebbit = await plebbit.createSubplebbit({ address: ipnsObj.signer.address });

            const errorPromise = new Promise<void>((resolve) => {
                tempSubplebbit.once("error", (err: PlebbitError | Error) => {
                    const pErr = err as PlebbitError;
                    if (isPlebbitFetchingUsingGateways(plebbit)) {
                        // we're using gateways to fetch
                        expect(pErr.code).to.equal("ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS");
                        for (const gatewayUrl of Object.keys(tempSubplebbit.clients.ipfsGateways)) {
                            expect((pErr.details.gatewayToError[gatewayUrl] as PlebbitError).code).to.equal("ERR_INVALID_JSON");
                        }
                    } else {
                        expect(pErr.code).to.equal("ERR_INVALID_JSON");
                    }
                    resolve();
                });
            });
            await tempSubplebbit.update();
            await errorPromise;

            await tempSubplebbit.stop();
            await ipnsObj.plebbit.destroy();
        });

        it(`subplebbit.update emits error and keeps retrying if address is name and name address has no subplebbit-address text record`, async () => {
            const sub = await plebbit.createSubplebbit({ address: "this-sub-does-not-exist.bso" });
            // Should emit an error and keep on retrying in the next update loop
            let errorCount = 0;
            let resolveErrorPromise: () => void;
            const errorPromise = new Promise<void>((resolve) => {
                resolveErrorPromise = resolve;
            });
            const errorListener = (err: PlebbitError | Error) => {
                expect((err as PlebbitError).code).to.equal("ERR_DOMAIN_TXT_RECORD_NOT_FOUND");
                expect(sub.updatingState).to.equal("waiting-retry");
                errorCount++;
                if (errorCount === 3) resolveErrorPromise();
            };
            sub.on("error", errorListener);
            await sub.update();
            await errorPromise;
            await sub.stop();
            sub.removeListener("error", errorListener);
        });

        it(`subplebbit.stop() stops subplebbit updates`, async () => {
            const remotePlebbit = await config.plebbitInstancePromise();
            const subplebbit = await remotePlebbit.createSubplebbit({ address: "plebbit.bso" }); // 'plebbit.eth' is part of test-server.js
            await subplebbit.update();
            await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
            await subplebbit.stop();
            let updatedHasBeenCalled = false;

            subplebbit.on("update", () => {
                updatedHasBeenCalled = true;
            });

            (subplebbit as unknown as Record<string, Function>).updateOnce = (
                subplebbit as unknown as Record<string, Function>
            )._setUpdatingState = async () => {
                updatedHasBeenCalled = true;
            };
            await new Promise((resolve) => setTimeout(resolve, remotePlebbit.updateInterval * 2));
            expect(updatedHasBeenCalled).to.be.false;
            await remotePlebbit.destroy();
        });

        it(`subplebbit.update() is working as expected after calling subplebbit.stop()`, async () => {
            const subplebbit = await plebbit.createSubplebbit({ address: signers[0].address });

            await subplebbit.update();
            await new Promise((resolve) => subplebbit.once("update", resolve));

            await subplebbit.stop();

            await subplebbit.update();

            await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });
            await new Promise((resolve) => subplebbit.once("update", resolve));
            await subplebbit.stop();
        });

        // Scenario A: {address: domain, publicKey: pkA} where domain resolves to pkB (key migration)
        it(`subplebbit.update() performs key migration when name resolves to different public key`, async () => {
            // "migrating.bso" is in defaultMockResolverRecords → signers[0].address,
            // which differs from the mocked record's signer → triggers key migration
            const { communityAddress: oldPublicKey } = await createMockedSubplebbitIpns({});
            const newPublicKey = signers[0].address; // domain will resolve to this different key

            const testPlebbit = await config.plebbitInstancePromise();

            try {
                const sub = await testPlebbit.createSubplebbit({ address: "migrating.bso", publicKey: oldPublicKey });
                expect(sub.address).to.equal("migrating.bso");
                expect(sub.publicKey).to.equal(oldPublicKey);

                const errorPromise = new Promise<PlebbitError>((resolve) => {
                    sub.on("error", (err) => {
                        if ((err as PlebbitError).code === "ERR_SUBPLEBBIT_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") {
                            resolve(err as PlebbitError);
                        }
                    });
                });

                // Wait for an update event where data has been cleared (key migration)
                const clearedUpdatePromise = new Promise<void>((resolve) => {
                    sub.on("update", () => {
                        if (sub.publicKey === newPublicKey && sub.updatedAt === undefined) {
                            resolve();
                        }
                    });
                });

                await sub.update();

                // Should emit ERR_SUBPLEBBIT_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY
                const error = await errorPromise;
                expect(error.details.previousPublicKey).to.equal(oldPublicKey);
                expect(error.details.newPublicKey).to.equal(newPublicKey);

                // Should emit update with cleared data
                await clearedUpdatePromise;
                expect(sub.updatedAt).to.be.undefined;
                expect(sub.title).to.be.undefined;
                expect(sub.signature).to.be.undefined;
                expect(sub.raw.subplebbitIpfs).to.be.undefined;
                expect(sub.updateCid).to.be.undefined;

                // address stays immutable
                expect(sub.address).to.equal("migrating.bso");
                // publicKey updated to new key
                expect(sub.publicKey).to.equal(newPublicKey);
                // nameResolved is true since domain resolved correctly to the new key
                expect(sub.nameResolved).to.equal(true);
                // IPNS routing props updated
                expect(sub.ipnsName).to.equal(newPublicKey);

                // Eventually loads new record from the new public key
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => typeof sub.updatedAt === "number"
                });
                expect(sub.publicKey).to.equal(newPublicKey);
                expect(sub.address).to.equal("migrating.bso");

                await sub.stop();
            } finally {
                await testPlebbit.destroy();
            }
        });

        // Scenario C: {address: domain} where record has name: "other.eth" (different name)
        it(`subplebbit.update() rejects record when record name differs from loaded domain address`, async () => {
            // "wrong-name.bso" is in defaultMockResolverRecords → signers[3].address
            // signers[3]'s record has name: "plebbit.bso", so "wrong-name.bso" ≠ "plebbit.bso" → rejection
            const testPlebbit = await config.plebbitInstancePromise();

            try {
                const sub = await testPlebbit.createSubplebbit({ address: "wrong-name.bso" });
                const errorPromise = new Promise<PlebbitError>((resolve) => sub.once("error", resolve as (err: Error) => void));

                await sub.update();
                const error = await errorPromise;

                if (isPlebbitFetchingUsingGateways(testPlebbit)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS");
                    for (const gatewayUrl of Object.keys(testPlebbit.clients.ipfsGateways)) {
                        expect((error.details.gatewayToError[gatewayUrl] as PlebbitError).code).to.equal(
                            "ERR_THE_SUBPLEBBIT_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED"
                        );
                    }
                } else {
                    expect(error.code).to.equal("ERR_THE_SUBPLEBBIT_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED");
                }
                // Record should not be accepted
                expect(sub.updatedAt).to.be.undefined;
                expect(sub.address).to.equal("wrong-name.bso");

                await sub.stop();
            } finally {
                await testPlebbit.destroy();
            }
        });

        it(`subplebbit.update() falls back to publicKey when name resolution fails and sets nameResolved=false`, async () => {
            // Default mock resolver can't resolve "unresolvable.bso" (not in default records) → falls back to publicKey
            const { communityAddress: publicKey } = await createMockedSubplebbitIpns({});

            const testPlebbit = await config.plebbitInstancePromise();

            try {
                const sub = await testPlebbit.createSubplebbit({ address: "unresolvable.bso", publicKey });

                // Should not emit the key migration error
                let keyMigrationErrorEmitted = false;
                sub.on("error", (err) => {
                    if ((err as PlebbitError).code === "ERR_SUBPLEBBIT_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") {
                        keyMigrationErrorEmitted = true;
                    }
                });

                await sub.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => typeof sub.updatedAt === "number"
                });

                // Record loaded via publicKey fallback
                expect(sub.updatedAt).to.be.a("number");
                expect(sub.address).to.equal("unresolvable.bso");
                expect(sub.publicKey).to.equal(publicKey);
                // Name could not be resolved (null returned), and sub.name is "unresolvable.bso",
                // so nameResolved should become false — background resolution emits "update"
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => sub.nameResolved === false
                });
                expect(sub.nameResolved).to.equal(false);
                expect(keyMigrationErrorEmitted).to.be.false;

                await sub.stop();
            } finally {
                await testPlebbit.destroy();
            }
        });

        // _clearDataForKeyMigration unit test
        itSkipIfRpc(`_clearDataForKeyMigration clears all data fields and updates key`, async () => {
            // Cannot run in RPC because we access internal methods directly
            const sub = await plebbit.createSubplebbit({ address: signers[0].address });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });
            await sub.stop();

            // Verify data is populated before clearing
            expect(sub.updatedAt).to.be.a("number");
            expect(sub.signature).to.not.be.undefined;

            const originalAddress = sub.address;
            const newKey = signers[1].address;

            sub._clearDataForKeyMigration(newKey);

            // All data fields should be cleared
            expect(sub.updatedAt).to.be.undefined;
            expect(sub.title).to.be.undefined;
            expect(sub.description).to.be.undefined;
            expect(sub.createdAt).to.be.undefined;
            expect(sub.signature).to.be.undefined;
            expect(sub.encryption).to.be.undefined;
            expect(sub.pubsubTopic).to.be.undefined;
            expect(sub.challenges).to.be.undefined;
            expect(sub.roles).to.be.undefined;
            expect(sub.rules).to.be.undefined;
            expect(sub.features).to.be.undefined;
            expect(sub.suggested).to.be.undefined;
            expect(sub.flairs).to.be.undefined;
            expect(sub.postUpdates).to.be.undefined;
            expect(sub.statsCid).to.be.undefined;
            expect(sub.lastPostCid).to.be.undefined;
            expect(sub.lastCommentCid).to.be.undefined;
            expect(sub.protocolVersion).to.be.undefined;
            expect(sub.raw.subplebbitIpfs).to.be.undefined;
            expect(sub.updateCid).to.be.undefined;

            // Address stays unchanged (immutable)
            expect(sub.address).to.equal(originalAddress);

            // Key updated
            expect(sub.publicKey).to.equal(newKey);
            expect(sub.ipnsName).to.equal(newKey);

            // Calling twice doesn't crash
            sub._clearDataForKeyMigration(newKey);
            expect(sub.address).to.equal(originalAddress);
            expect(sub.publicKey).to.equal(newKey);
        });

        it(`subplebbit.update() emits an error if subplebbit record is over 1mb`, async () => {
            // plebbit-js will emit an error once, mark the invalid cid, and never retry
            const twoMbObject = { testString: "x".repeat(2 * 1024 * 1024) }; //2mb

            const ipnsObj = await createNewIpns();

            await ipnsObj.publishToIpns(JSON.stringify(twoMbObject));

            const tempSubplebbit = await plebbit.createSubplebbit({ address: ipnsObj.signer.address });

            const errorPromise = new Promise<PlebbitError>((resolve) => tempSubplebbit.once("error", resolve as (err: Error) => void));
            await tempSubplebbit.update();
            const err = await errorPromise;
            await tempSubplebbit.stop();

            if (isPlebbitFetchingUsingGateways(plebbit)) {
                // we're using gateways to fetch
                expect(err.code).to.equal("ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS");
                for (const gatewayUrl of Object.keys(tempSubplebbit.clients.ipfsGateways))
                    expect((err.details.gatewayToError[gatewayUrl] as PlebbitError).code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
            } else expect(err.code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
            await ipnsObj.plebbit.destroy();
        });

        // Verify that background name resolution emits "update" independently of subplebbitIpfs changes
        it(`background name resolution emits update with nameResolved=true without a new subplebbitIpfs record`, async () => {
            const sub = await plebbit.createSubplebbit({ address: nameSubplebbitSigner.address });
            await sub.update();
            // Wait for the initial record to load
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });
            // Capture the record state — nameResolved may still be undefined (background resolution is async)
            const updatedAtBeforeNameResolved = sub.updatedAt;
            const updateCidBeforeNameResolved = sub.updateCid;

            // Wait for background resolution to set nameResolved=true via an "update" event
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => sub.nameResolved === true
            });
            // The subplebbitIpfs record should be unchanged — update was triggered solely by nameResolved
            expect(sub.updatedAt).to.equal(updatedAtBeforeNameResolved);
            expect(sub.updateCid).to.equal(updateCidBeforeNameResolved);
            expect(sub.nameResolved).to.equal(true);
            expect(sub.address).to.equal(nameSubplebbitSigner.address);
            await sub.stop();
        });

        it(`background name resolution emits update with nameResolved=false without a new subplebbitIpfs record`, async () => {
            const { communityAddress: ipnsKey } = await createMockedSubplebbitIpns({ name: "unresolvable-name-independent.bso" });

            const testPlebbit = await config.plebbitInstancePromise({
                mockResolve: false,
                plebbitOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            records: new Map([["unresolvable-name-independent.bso", undefined]])
                        })
                    ]
                }
            });

            try {
                const sub = await testPlebbit.createSubplebbit({ address: ipnsKey });
                await sub.update();
                // Wait for the initial record to load
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => typeof sub.updatedAt === "number"
                });
                expect(sub.name).to.equal("unresolvable-name-independent.bso");
                // Capture the record state
                const updatedAtBeforeNameResolved = sub.updatedAt;
                const updateCidBeforeNameResolved = sub.updateCid;

                // Wait for background resolution to set nameResolved=false via an "update" event
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => sub.nameResolved === false
                });
                // The subplebbitIpfs record should be unchanged — update was triggered solely by nameResolved
                expect(sub.updatedAt).to.equal(updatedAtBeforeNameResolved);
                expect(sub.updateCid).to.equal(updateCidBeforeNameResolved);
                expect(sub.nameResolved).to.equal(false);
                expect(sub.address).to.equal(ipnsKey);
                await sub.stop();
            } finally {
                await testPlebbit.destroy();
            }
        });

        it(`page comment author background resolution does not emit spurious update on subplebbit`, async () => {
            // Load a subplebbit that has pages with domain-author comments
            const sub = await plebbit.createSubplebbit({ address: signers[0].address });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => Boolean(sub.posts?.pages?.hot?.comments?.length)
            });

            // Track whether nameResolved ever gets set on the subplebbit itself
            // (it shouldn't — signers[0].address is a B58 key, not a domain)
            let nameResolvedEverChanged = false;
            const onUpdate = () => {
                if (typeof sub.nameResolved === "boolean") {
                    nameResolvedEverChanged = true;
                }
            };
            sub.on("update", onUpdate);

            // Wait to let any pending background page author resolution settle
            await new Promise((resolve) => setTimeout(resolve, 2000));

            sub.removeListener("update", onUpdate);
            await sub.stop();

            // subplebbit.nameResolved should remain undefined (no community domain to resolve)
            expect(sub.nameResolved).to.be.undefined;
            expect(nameResolvedEverChanged).to.be.false;
        });
    });
});

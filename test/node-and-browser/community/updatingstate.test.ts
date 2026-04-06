import signers from "../../fixtures/signers.js";

import { describe, it, beforeAll, afterAll } from "vitest";
import {
    publishRandomPost,
    publishCommunityRecordWithExtraProp,
    createStaticCommunityRecordForComment,
    createNewIpns,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describe.concurrent(`subplebbit.updatingState (node/browser - remote sub) - ${config.name}`, async () => {
        let plebbit: PKCType;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });
        afterAll(async () => {
            await plebbit.destroy();
        });
        it(`subplebbit.updatingState is included when spreading or JSON.stringify`, async () => {
            const subplebbit = await plebbit.createCommunity({ address: signers[0].address });
            const spreadCommunity = { ...subplebbit };
            const jsonCommunity = JSON.parse(JSON.stringify(subplebbit));

            expect(spreadCommunity).to.have.property("updatingState", subplebbit.updatingState);
            expect(jsonCommunity).to.have.property("updatingState", subplebbit.updatingState);
        });
        it(`subplebbit.updatingState is in correct order upon updating with IPFS client and plebbit.createCommunity() `, async () => {
            const subplebbit = await plebbit.createCommunity({ address: signers[0].address });
            const recordedStates: string[] = [];
            const expectedStates = ["fetching-ipns", "fetching-ipfs", "succeeded", "stopped"];
            subplebbit.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => subplebbit.once("update", resolve));
            await subplebbit.update();
            await updatePromise;
            await subplebbit.stop();

            expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
        });

        it(`subplebbit.updatingState is in correct order upon updating with IPFS client and plebbit.getCommunity({address) with subplebbit address not an ENS`, async () => {
            const subplebbit = await plebbit.getCommunity({ address: signers[0].address });
            const oldUpdatedAt = Number(subplebbit.updatedAt);
            const recordedStates: string[] = [];
            const expectedStates = ["fetching-ipns", "fetching-ipfs", "succeeded", "stopped"];
            subplebbit.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });
            await subplebbit.update();
            await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => Number(subplebbit.updatedAt) > oldUpdatedAt });
            await subplebbit.stop();
            expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
        });

        it(`subplebbit.updatingState is in correct order upon updating with IPFS client and subplebbit address is an ENS`, async () => {
            const subplebbit = await plebbit.createCommunity({ address: "plebbit.eth" });
            const recordedStates: string[] = [];
            const expectedStates = ["resolving-name", "fetching-ipns", "fetching-ipfs", "succeeded", "stopped"];
            subplebbit.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => subplebbit.once("update", resolve));
            await subplebbit.update();
            expect(subplebbit.state).to.equal("updating");

            await updatePromise;
            await updatePromise;
            await subplebbit.stop();
            expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
        });

        it("updating states is in correct order upon updating with ipfs p2p, if the sub doesn't publish any updates", async () => {
            const newSub = await publishCommunityRecordWithExtraProp();

            const subplebbit = await plebbit.createCommunity({ address: newSub.ipnsObj.signer.address });

            const recordedStates: string[] = [];
            subplebbit.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => subplebbit.once("update", resolve));
            await subplebbit.update();

            await updatePromise;

            // Wait for at least 2 complete retry cycles (pairs of fetching-ipns + waiting-retry)
            await resolveWhenConditionIsTrue({
                toUpdate: subplebbit,
                predicate: async () => {
                    const waitingRetryCount = recordedStates.filter((s) => s === "waiting-retry").length;
                    return waitingRetryCount >= 2;
                },
                eventName: "updatingstatechange"
            });

            await subplebbit.stop();

            const expectedFirstUpdateStates = ["fetching-ipns", "fetching-ipfs", "succeeded"];

            expect(recordedStates.slice(0, expectedFirstUpdateStates.length)).to.deep.equal(expectedFirstUpdateStates);

            expect(recordedStates[recordedStates.length - 1]).to.equal("stopped");
            const noNewUpdateStates = recordedStates.slice(expectedFirstUpdateStates.length, recordedStates.length - 1); // should be just 'fetching-ipns' and 'succeeded
            expect(noNewUpdateStates.length).to.be.greaterThan(0);

            // Check that every pair of states is ["fetching-ipns", "waiting-retry"]
            for (let i = 0; i < noNewUpdateStates.length; i += 2) {
                expect(noNewUpdateStates[i]).to.equal("fetching-ipns");
                expect(noNewUpdateStates[i + 1]).to.equal("waiting-retry");
            }
        });

        it(`updatingState is correct when we attempt to update a subplebbit with invalid record, if we're updating with an ipfs client`, async () => {
            // Create a subplebbit with a valid address
            const { commentCid, communityAddress: subplebbitAddress } = await createStaticCommunityRecordForComment({
                invalidateCommunitySignature: true
            });

            const subplebbit = await plebbit.createCommunity({ address: subplebbitAddress });

            const recordedUpdatingStates: string[] = [];
            const errors: PKCError[] = [];

            subplebbit.on("updatingstatechange", (newState: string) => recordedUpdatingStates.push(newState));
            subplebbit.on("error", (err: PKCError | Error) => {
                errors.push(err as PKCError);
            });

            // First update should succeed with the initial valid record
            const errorPromise = new Promise((resolve) => subplebbit.once("error", resolve));

            await subplebbit.update();

            await errorPromise;

            // Wait for at least 2 complete retry cycles (pairs of fetching-ipns + waiting-retry)
            await resolveWhenConditionIsTrue({
                toUpdate: subplebbit,
                predicate: async () => {
                    const waitingRetryCount = recordedUpdatingStates.filter((s) => s === "waiting-retry").length;
                    return waitingRetryCount >= 2;
                },
                eventName: "updatingstatechange"
            });

            await subplebbit.stop();

            const expectedFirstStates = ["fetching-ipns", "fetching-ipfs", "failed"];
            expect(recordedUpdatingStates.slice(0, expectedFirstStates.length)).to.deep.equal(expectedFirstStates);

            // Remaining states should loop as ["fetching-ipns", "stopped"] when it keeps failing
            const remainingStates = recordedUpdatingStates.slice(expectedFirstStates.length, recordedUpdatingStates.length - 1);
            expect(remainingStates.length % 2).to.equal(0);
            for (let i = 0; i < remainingStates.length; i += 2) {
                expect(remainingStates.slice(i, i + 2)).to.deep.equal(["fetching-ipns", "waiting-retry"]); // resolves IPNS, then realizes it's the same IPNS with invalid signature and abort
            }

            expect(recordedUpdatingStates[recordedUpdatingStates.length - 1]).to.equal("stopped");

            expect(errors.length).to.equal(1);
            expect(errors[0].code).to.equal("ERR_COMMUNITY_SIGNATURE_IS_INVALID");
        });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`subplebbit.updatingState (node/browser - remote sub) - ${config.name}`, async () => {
        let plebbit: PKCType;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });
        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`subplebbit.updatingState defaults to stopped after plebbit.createCommunity()`, async () => {
            const subplebbit = await plebbit.createCommunity({ address: signers[0].address });
            expect(subplebbit.updatingState).to.equal("stopped");
        });

        it(`subplebbit.updatingState defaults to stopped after plebbit.getCommunity({address})`, async () => {
            const subplebbit = await plebbit.getCommunity({ address: signers[0].address });
            expect(subplebbit.updatingState).to.equal("stopped");
        });

        it(`the order of state-event-statechange is correct when we get a new update from the subplebbit`, async () => {
            // this test used to be flaky on rpc I assume because rpc server kept updating the sub with another client, it was tricky to fix
            // easy fix for now is to put an addresso of a less used subplebbit
            const subplebbit = await plebbit.createCommunity({ address: signers[1].address }); // this sub should get less updates

            const recordedStates: string[] = [];
            subplebbit.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise<void>((resolve, reject) =>
                subplebbit.once("update", () => {
                    if (subplebbit.updatingState !== "succeeded") reject("if it emits update, updatingState should succeed");
                    if (recordedStates.length === 0) reject("if it emits update, updatingStatechange should have been emitted");
                    if (recordedStates[recordedStates.length - 1] === "succeeded")
                        reject("if it emits update, updatingStatechange not emit yet");
                    resolve();
                })
            );
            await subplebbit.update();

            await updatePromise;

            await subplebbit.stop();
        });

        it(`the order of state-event-statechange is correct when we fail to load subplebbit with critical error`, async () => {
            // Mock the subplebbit to return an invalid record

            const twoMbObject = { testString: "x".repeat(2 * 1024 * 1024) }; //2mb

            const ipnsObj = await createNewIpns();

            await ipnsObj.publishToIpns(JSON.stringify(twoMbObject));

            const recordedUpdatingStates: string[] = [];
            const errors: PKCError[] = [];

            // when error is emitted, updatingState should be set to failed
            // but it should not emit updatingstatechange event

            const subplebbit = await plebbit.createCommunity({ address: ipnsObj.signer.address });
            subplebbit.on("updatingstatechange", (newState: string) => recordedUpdatingStates.push(newState));
            subplebbit.on("error", (err: PKCError | Error) => {
                errors.push(err as PKCError);
            });

            // First update should succeed with the initial valid record
            await subplebbit.update();

            const errorPromise = new Promise<void>((resolve, reject) =>
                subplebbit.once("error", (err: PKCError | Error) => {
                    if (subplebbit.updatingState !== "failed") reject("if it emits error, updatingState should be failed");
                    if (recordedUpdatingStates.length === 0) reject("if it emits error, updatingStatechange should have been emitted");
                    if (recordedUpdatingStates[recordedUpdatingStates.length - 1] === "failed")
                        reject("if it emits error, updatingStatechange not emit yet");
                    resolve();
                })
            );

            await errorPromise;

            await subplebbit.stop();
            await ipnsObj.plebbit.destroy();
        });
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`subplebbit.updatingState (node/browser - remote sub) - ${config.name}`, async () => {
        let plebbit: PKCType;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });
        afterAll(async () => {
            await plebbit.destroy();
        });
        it(`updating states is in correct order upon updating with gateway`, async () => {
            const subplebbit = await plebbit.createCommunity({ address: signers[0].address });

            const expectedStates = ["fetching-ipns", "succeeded", "stopped"];
            const recordedStates: string[] = [];
            subplebbit.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => subplebbit.once("update", resolve));

            await subplebbit.update();

            await updatePromise;
            await subplebbit.stop();

            expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
        });

        it("updating states is in correct order upon updating with gateway, if the sub doesn't publish any updates", async () => {
            const newSub = await publishCommunityRecordWithExtraProp();

            const subplebbit = await plebbit.createCommunity({ address: newSub.ipnsObj.signer.address });

            const recordedStates: string[] = [];
            subplebbit.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => subplebbit.once("update", resolve));
            await subplebbit.update();

            await updatePromise;

            // Wait for at least 2 complete retry cycles (pairs of fetching-ipns + waiting-retry)
            await resolveWhenConditionIsTrue({
                toUpdate: subplebbit,
                predicate: async () => {
                    const waitingRetryCount = recordedStates.filter((s) => s === "waiting-retry").length;
                    return waitingRetryCount >= 2;
                },
                eventName: "updatingstatechange"
            });

            await subplebbit.stop();

            const expectedFirstUpdateStates = ["fetching-ipns", "succeeded"];

            expect(recordedStates.slice(0, expectedFirstUpdateStates.length)).to.deep.equal(expectedFirstUpdateStates);

            expect(recordedStates[recordedStates.length - 1]).to.equal("stopped");
            const noNewUpdateStates = recordedStates.slice(expectedFirstUpdateStates.length, recordedStates.length - 1); // should be just 'fetching-ipns' and 'succeeded

            expect(noNewUpdateStates.length).to.be.greaterThan(0);
            // Check that every pair of states is ["fetching-ipns", "waiting-retry"]
            for (let i = 0; i < noNewUpdateStates.length; i += 2) {
                expect(noNewUpdateStates[i]).to.equal("fetching-ipns");
                expect(noNewUpdateStates[i + 1]).to.equal("waiting-retry");
            }
        });

        it(`updatingState is correct when we attempt to update a subplebbit with invalid record, if we're updating with an ipfs gateways`, async () => {
            const { commentCid, communityAddress: subplebbitAddress } = await createStaticCommunityRecordForComment({
                invalidateCommunitySignature: true
            });

            // Create a subplebbit with a valid address
            const subplebbit = await plebbit.createCommunity({ address: subplebbitAddress });

            const recordedUpdatingStates: string[] = [];
            const errors: PKCError[] = [];

            subplebbit.on("updatingstatechange", (newState: string) => recordedUpdatingStates.push(newState));
            subplebbit.on("error", (err: PKCError | Error) => {
                errors.push(err as PKCError);
            });

            // First update should succeed with the initial valid record
            const errorPromise = new Promise((resolve) => subplebbit.once("error", resolve));
            await subplebbit.update();
            await errorPromise;

            // Wait for at least 2 complete retry cycles (pairs of fetching-ipns + waiting-retry)
            await resolveWhenConditionIsTrue({
                toUpdate: subplebbit,
                predicate: async () => {
                    const waitingRetryCount = recordedUpdatingStates.filter((s) => s === "waiting-retry").length;
                    return waitingRetryCount >= 2;
                },
                eventName: "updatingstatechange"
            });

            await subplebbit.stop();

            const expectedFirstStates = ["fetching-ipns", "failed"];
            expect(recordedUpdatingStates.slice(0, expectedFirstStates.length)).to.deep.equal(expectedFirstStates);

            // Remaining states should loop as ["fetching-ipns", "stopped"] when it keeps failing
            const remainingStates = recordedUpdatingStates.slice(expectedFirstStates.length, recordedUpdatingStates.length - 1);
            expect(remainingStates.length % 2).to.equal(0);
            for (let i = 0; i < remainingStates.length; i += 2) {
                expect(remainingStates.slice(i, i + 2)).to.deep.equal(["fetching-ipns", "waiting-retry"]); // resolves IPNS, then realizes it's the same IPNS with invalid signature and abort
            }

            expect(recordedUpdatingStates[recordedUpdatingStates.length - 1]).to.equal("stopped");

            expect(errors.length).to.equal(1);
            expect(errors[0].code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
            expect((errors[0].details.gatewayToError["http://localhost:18080"] as PKCError).code).to.equal(
                "ERR_COMMUNITY_SIGNATURE_IS_INVALID"
            );
        });
    });
});

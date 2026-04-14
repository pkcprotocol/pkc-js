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
    describe.concurrent(`community.updatingState (node/browser - remote community) - ${config.name}`, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });
        it(`community.updatingState is included when spreading or JSON.stringify`, async () => {
            const community = await pkc.createCommunity({ address: signers[0].address });
            const spreadCommunity = { ...community };
            const jsonCommunity = JSON.parse(JSON.stringify(community));

            expect(spreadCommunity).to.have.property("updatingState", community.updatingState);
            expect(jsonCommunity).to.have.property("updatingState", community.updatingState);
        });
        it(`community.updatingState is in correct order upon updating with IPFS client and pkc.createCommunity() `, async () => {
            const community = await pkc.createCommunity({ address: signers[0].address });
            const recordedStates: string[] = [];
            const expectedStates = ["fetching-ipns", "fetching-ipfs", "succeeded", "stopped"];
            community.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();
            await updatePromise;
            await community.stop();

            expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
        });

        it(`community.updatingState is in correct order upon updating with IPFS client and pkc.getCommunity({address) with community address not an ENS`, async () => {
            const community = await pkc.getCommunity({ address: signers[0].address });
            const oldUpdatedAt = Number(community.updatedAt);
            const recordedStates: string[] = [];
            const expectedStates = ["fetching-ipns", "fetching-ipfs", "succeeded", "stopped"];
            community.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            await publishRandomPost({ communityAddress: community.address, pkc: pkc });
            await community.update();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => Number(community.updatedAt) > oldUpdatedAt });
            await community.stop();
            expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
        });

        it(`community.updatingState should never emit "resolving-name" when community address is not a domain`, async () => {
            // Regression: background author name resolution was incorrectly setting
            // community.updatingState to "resolving-name" after "succeeded"
            const community = await pkc.createCommunity({ address: signers[1].address });
            const recordedStates: string[] = [];
            community.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();
            await updatePromise;
            await community.stop();

            expect(recordedStates.filter((s) => s === "resolving-name")).to.have.length(0);
        });

        it(`community.updatingState is in correct order upon updating with IPFS client and community address is an ENS`, async () => {
            const community = await pkc.createCommunity({ address: "plebbit.eth" });
            const recordedStates: string[] = [];
            const expectedStates = ["resolving-name", "fetching-ipns", "fetching-ipfs", "succeeded", "stopped"];
            community.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();
            expect(community.state).to.equal("updating");

            await updatePromise;
            await updatePromise;
            await community.stop();
            expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
        });

        it("updating states is in correct order upon updating with ipfs p2p, if the community doesn't publish any updates", async () => {
            const newCommunity = await publishCommunityRecordWithExtraProp();

            const community = await pkc.createCommunity({ address: newCommunity.ipnsObj.signer.address });

            const recordedStates: string[] = [];
            community.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();

            await updatePromise;

            // Wait for at least 2 complete retry cycles (pairs of fetching-ipns + waiting-retry)
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const waitingRetryCount = recordedStates.filter((s) => s === "waiting-retry").length;
                    return waitingRetryCount >= 2;
                },
                eventName: "updatingstatechange"
            });

            await community.stop();

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

        it(`updatingState is correct when we attempt to update a community with invalid record, if we're updating with an ipfs client`, async () => {
            // Create a community with a valid address
            const { commentCid, communityAddress: communityAddress } = await createStaticCommunityRecordForComment({
                invalidateCommunitySignature: true
            });

            const community = await pkc.createCommunity({ address: communityAddress });

            const recordedUpdatingStates: string[] = [];
            const errors: PKCError[] = [];

            community.on("updatingstatechange", (newState: string) => recordedUpdatingStates.push(newState));
            community.on("error", (err: PKCError | Error) => {
                errors.push(err as PKCError);
            });

            // First update should succeed with the initial valid record
            const errorPromise = new Promise((resolve) => community.once("error", resolve));

            await community.update();

            await errorPromise;

            // Wait for at least 2 complete retry cycles (pairs of fetching-ipns + waiting-retry)
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const waitingRetryCount = recordedUpdatingStates.filter((s) => s === "waiting-retry").length;
                    return waitingRetryCount >= 2;
                },
                eventName: "updatingstatechange"
            });

            await community.stop();

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
    describe(`community.updatingState (node/browser - remote community) - ${config.name}`, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it(`community.updatingState defaults to stopped after pkc.createCommunity()`, async () => {
            const community = await pkc.createCommunity({ address: signers[0].address });
            expect(community.updatingState).to.equal("stopped");
        });

        it(`community.updatingState defaults to stopped after pkc.getCommunity({address})`, async () => {
            const community = await pkc.getCommunity({ address: signers[0].address });
            expect(community.updatingState).to.equal("stopped");
        });

        it(`the order of state-event-statechange is correct when we get a new update from the community`, async () => {
            // this test used to be flaky on rpc I assume because rpc server kept updating the community with another client, it was tricky to fix
            // easy fix for now is to put an addresso of a less used community
            const community = await pkc.createCommunity({ address: signers[1].address }); // this community should get less updates

            const recordedStates: string[] = [];
            community.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise<void>((resolve, reject) =>
                community.once("update", () => {
                    if (community.updatingState !== "succeeded") reject("if it emits update, updatingState should succeed");
                    if (recordedStates.length === 0) reject("if it emits update, updatingStatechange should have been emitted");
                    if (recordedStates[recordedStates.length - 1] === "succeeded")
                        reject("if it emits update, updatingStatechange not emit yet");
                    resolve();
                })
            );
            await community.update();

            await updatePromise;

            await community.stop();
        });

        it(`the order of state-event-statechange is correct when we fail to load community with critical error`, async () => {
            // Mock the community to return an invalid record

            const twoMbObject = { testString: "x".repeat(2 * 1024 * 1024) }; //2mb

            const ipnsObj = await createNewIpns();

            await ipnsObj.publishToIpns(JSON.stringify(twoMbObject));

            const recordedUpdatingStates: string[] = [];
            const errors: PKCError[] = [];

            // when error is emitted, updatingState should be set to failed
            // but it should not emit updatingstatechange event

            const community = await pkc.createCommunity({ address: ipnsObj.signer.address });
            community.on("updatingstatechange", (newState: string) => recordedUpdatingStates.push(newState));
            community.on("error", (err: PKCError | Error) => {
                errors.push(err as PKCError);
            });

            // First update should succeed with the initial valid record
            await community.update();

            const errorPromise = new Promise<void>((resolve, reject) =>
                community.once("error", (err: PKCError | Error) => {
                    if (community.updatingState !== "failed") reject("if it emits error, updatingState should be failed");
                    if (recordedUpdatingStates.length === 0) reject("if it emits error, updatingStatechange should have been emitted");
                    if (recordedUpdatingStates[recordedUpdatingStates.length - 1] === "failed")
                        reject("if it emits error, updatingStatechange not emit yet");
                    resolve();
                })
            );

            await errorPromise;

            await community.stop();
            await ipnsObj.pkc.destroy();
        });
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`community.updatingState (node/browser - remote community) - ${config.name}`, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });
        it(`updating states is in correct order upon updating with gateway`, async () => {
            const community = await pkc.createCommunity({ address: signers[0].address });

            const expectedStates = ["fetching-ipns", "succeeded", "stopped"];
            const recordedStates: string[] = [];
            community.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => community.once("update", resolve));

            await community.update();

            await updatePromise;
            await community.stop();

            expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
        });

        it("updating states is in correct order upon updating with gateway, if the community doesn't publish any updates", async () => {
            const newCommunity = await publishCommunityRecordWithExtraProp();

            const community = await pkc.createCommunity({ address: newCommunity.ipnsObj.signer.address });

            const recordedStates: string[] = [];
            community.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();

            await updatePromise;

            // Wait for at least 2 complete retry cycles (pairs of fetching-ipns + waiting-retry)
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const waitingRetryCount = recordedStates.filter((s) => s === "waiting-retry").length;
                    return waitingRetryCount >= 2;
                },
                eventName: "updatingstatechange"
            });

            await community.stop();

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

        it(`updatingState is correct when we attempt to update a community with invalid record, if we're updating with an ipfs gateways`, async () => {
            const { commentCid, communityAddress: communityAddress } = await createStaticCommunityRecordForComment({
                invalidateCommunitySignature: true
            });

            // Create a community with a valid address
            const community = await pkc.createCommunity({ address: communityAddress });

            const recordedUpdatingStates: string[] = [];
            const errors: PKCError[] = [];

            community.on("updatingstatechange", (newState: string) => recordedUpdatingStates.push(newState));
            community.on("error", (err: PKCError | Error) => {
                errors.push(err as PKCError);
            });

            // First update should succeed with the initial valid record
            const errorPromise = new Promise((resolve) => community.once("error", resolve));
            await community.update();
            await errorPromise;

            // Wait for at least 2 complete retry cycles (pairs of fetching-ipns + waiting-retry)
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const waitingRetryCount = recordedUpdatingStates.filter((s) => s === "waiting-retry").length;
                    return waitingRetryCount >= 2;
                },
                eventName: "updatingstatechange"
            });

            await community.stop();

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

import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";
import {
    publishRandomPost,
    getAvailablePKCConfigsToTestAgainst,
    createStaticCommunityRecordForComment,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`community.clients.ipfsGateways - ${config.name}`, async () => {
        // All tests below use PKC instance that doesn't have clients.kuboRpcClients
        let gatewayPKC: PKCType;

        beforeAll(async () => {
            gatewayPKC = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await gatewayPKC.destroy();
        });

        it(`community.clients.ipfsGateways[url] is stopped by default`, async () => {
            const mockSub = await gatewayPKC.getCommunity({ address: communityAddress });
            expect(Object.keys(mockSub.clients.ipfsGateways).length).to.equal(1);
            expect(Object.values(mockSub.clients.ipfsGateways)[0].state).to.equal("stopped");
        });

        it(`Correct order of ipfsGateways state when updating a community that was created with pkc.createCommunity({address})`, async () => {
            const community = await gatewayPKC.createCommunity({ address: signers[0].address });

            const expectedStates = ["fetching-ipns", "stopped"];

            const actualStates: string[] = [];

            const gatewayUrl = Object.keys(community.clients.ipfsGateways)[0];

            community.clients.ipfsGateways[gatewayUrl].on("statechange", (newState: string) => actualStates.push(newState));

            await community.update();
            await new Promise((resolve) => community.once("update", resolve));
            await community.stop();

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of ipfsGateways state when updating a community that was created with pkc.getCommunity({address: address})`, async () => {
            const community = await gatewayPKC.getCommunity({ address: signers[0].address });
            await publishRandomPost({ communityAddress: community.address, pkc: gatewayPKC });

            const expectedStates = ["fetching-ipns", "stopped"];

            const actualStates: string[] = [];

            const gatewayUrl = Object.keys(community.clients.ipfsGateways)[0];

            community.clients.ipfsGateways[gatewayUrl].on("statechange", (newState: string) => actualStates.push(newState));

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();
            await updatePromise;
            await community.stop();

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of ipfs gateway state when we update a community and it's not publishing new community records`, async () => {
            const { commentCid, communityAddress: communityAddress } = await createStaticCommunityRecordForComment();
            // communityAddress is static and won't be publishing new updates

            const community = await gatewayPKC.createCommunity({ address: communityAddress });
            expect(community.updatedAt).to.be.undefined; // should not get an update yet

            let updateCount = 0;
            community.on("update", () => updateCount++);
            let waitingRetryCount = 0;
            community.on("updatingstatechange", (newState: string) => newState === "waiting-retry" && waitingRetryCount++);

            const recordedStates: string[] = [];
            const gatewayUrl = Object.keys(community.clients.ipfsGateways)[0];
            community.clients.ipfsGateways[gatewayUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            // now gatewayPKC._updatingCommunities will be defined

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();
            await updatePromise;

            const expectedWaitingRetryCount = 3;
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => waitingRetryCount === expectedWaitingRetryCount,
                eventName: "updatingstatechange"
            });

            await community.stop();

            expect(updateCount).to.equal(1); // only one update cause we're not publishing anymore
            expect(waitingRetryCount).to.equal(expectedWaitingRetryCount);
            // should be just ["fetching-ipns", "stopped"]
            // because it can't find a new record
            for (let i = 0; i < recordedStates.length; i += 2) {
                expect(recordedStates[i]).to.equal("fetching-ipns");
                expect(recordedStates[i + 1]).to.equal("stopped");
            }
        });

        it(`Correct order of ipfs gateway states when we update a community with record whose signature is invalid (silently retries)`, async () => {
            const { commentCid, communityAddress: communityAddress } = await createStaticCommunityRecordForComment({
                invalidateCommunitySignature: true
            });
            // communityAddress is static and is already published an invalid record

            const community = await gatewayPKC.createCommunity({ address: communityAddress });
            expect(community.updatedAt).to.be.undefined;

            let updateCount = 0;
            community.on("update", () => updateCount++);

            let waitingRetryCount = 0;
            community.on("updatingstatechange", (newState: string) => newState === "waiting-retry" && waitingRetryCount++);

            const emittedErrors: PKCError[] = [];
            community.on("error", (error: PKCError | Error) => {
                emittedErrors.push(error as PKCError);
            });

            // Record states for verification
            const recordedStates: string[] = [];
            const gatewayUrl = Object.keys(community.clients.ipfsGateways)[0];
            community.clients.ipfsGateways[gatewayUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            await community.update();

            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => waitingRetryCount >= 2,
                eventName: "updatingstatechange"
            });

            await community.stop();
            expect(community.updatedAt).to.be.undefined; // should not defined since signature is invalid

            // verifying states for the first correct update
            expect(recordedStates.slice(0, 2)).to.deep.equal(["fetching-ipns", "stopped"]);

            // verifying states for the first error
            expect(recordedStates.slice(2, 4)).to.deep.equal(["fetching-ipns", "stopped"]);

            // verifying states for the waiting retries, because it can't find a new record
            for (let i = 0; i < recordedStates.length; i += 2) {
                expect(recordedStates[i]).to.equal("fetching-ipns");
                expect(recordedStates[i + 1]).to.equal("stopped");
            }

            // Gateway invalid signature errors are silently retriable — no error event emitted
            expect(emittedErrors.length).to.equal(0);

            expect(waitingRetryCount).to.be.greaterThan(0);
            expect(updateCount).to.equal(0); // no updatess because invalid signatures
        });
    });
});

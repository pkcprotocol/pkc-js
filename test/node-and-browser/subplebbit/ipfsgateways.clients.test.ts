import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";
import {
    publishRandomPost,
    getAvailablePlebbitConfigsToTestAgainst,
    createStaticSubplebbitRecordForComment,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { PlebbitError } from "../../../dist/node/plebbit-error.js";
const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`subplebbit.clients.ipfsGateways - ${config.name}`, async () => {
        // All tests below use Plebbit instance that doesn't have clients.kuboRpcClients
        let gatewayPlebbit: PlebbitType;

        beforeAll(async () => {
            gatewayPlebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await gatewayPlebbit.destroy();
        });

        it(`subplebbit.clients.ipfsGateways[url] is stopped by default`, async () => {
            const mockSub = await gatewayPlebbit.getSubplebbit({ address: subplebbitAddress });
            expect(Object.keys(mockSub.clients.ipfsGateways).length).to.equal(1);
            expect(Object.values(mockSub.clients.ipfsGateways)[0].state).to.equal("stopped");
        });

        it(`Correct order of ipfsGateways state when updating a subplebbit that was created with plebbit.createSubplebbit({address})`, async () => {
            const sub = await gatewayPlebbit.createSubplebbit({ address: signers[0].address });

            const expectedStates = ["fetching-ipns", "stopped"];

            const actualStates: string[] = [];

            const gatewayUrl = Object.keys(sub.clients.ipfsGateways)[0];

            sub.clients.ipfsGateways[gatewayUrl].on("statechange", (newState: string) => actualStates.push(newState));

            await sub.update();
            await new Promise((resolve) => sub.once("update", resolve));
            await sub.stop();

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of ipfsGateways state when updating a subplebbit that was created with plebbit.getSubplebbit({address: address})`, async () => {
            const sub = await gatewayPlebbit.getSubplebbit({ address: signers[0].address });
            await publishRandomPost({ subplebbitAddress: sub.address, plebbit: gatewayPlebbit });

            const expectedStates = ["fetching-ipns", "stopped"];

            const actualStates: string[] = [];

            const gatewayUrl = Object.keys(sub.clients.ipfsGateways)[0];

            sub.clients.ipfsGateways[gatewayUrl].on("statechange", (newState: string) => actualStates.push(newState));

            const updatePromise = new Promise((resolve) => sub.once("update", resolve));
            await sub.update();
            await updatePromise;
            await sub.stop();

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of ipfs gateway state when we update a subplebbit and it's not publishing new subplebbit records`, async () => {
            const { commentCid, subplebbitAddress } = await createStaticSubplebbitRecordForComment();
            // subAddress is static and won't be publishing new updates

            const sub = await gatewayPlebbit.createSubplebbit({ address: subplebbitAddress });
            expect(sub.updatedAt).to.be.undefined; // should not get an update yet

            let updateCount = 0;
            sub.on("update", () => updateCount++);
            let waitingRetryCount = 0;
            sub.on("updatingstatechange", (newState: string) => newState === "waiting-retry" && waitingRetryCount++);

            const recordedStates: string[] = [];
            const gatewayUrl = Object.keys(sub.clients.ipfsGateways)[0];
            sub.clients.ipfsGateways[gatewayUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            // now gatewayPlebbit._updatingSubplebbits will be defined

            const updatePromise = new Promise((resolve) => sub.once("update", resolve));
            await sub.update();
            await updatePromise;

            const expectedWaitingRetryCount = 3;
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => waitingRetryCount === expectedWaitingRetryCount,
                eventName: "updatingstatechange"
            });

            await sub.stop();

            expect(updateCount).to.equal(1); // only one update cause we're not publishing anymore
            expect(waitingRetryCount).to.equal(expectedWaitingRetryCount);
            // should be just ["fetching-ipns", "stopped"]
            // because it can't find a new record
            for (let i = 0; i < recordedStates.length; i += 2) {
                expect(recordedStates[i]).to.equal("fetching-ipns");
                expect(recordedStates[i + 1]).to.equal("stopped");
            }
        });

        it(`Correct order of ipfs gateway states when we update a subplebbit with record whose signature is invalid`, async () => {
            const { commentCid, subplebbitAddress } = await createStaticSubplebbitRecordForComment({ invalidateSubplebbitSignature: true });
            // subAddress is static and is already published an invalid record

            const sub = await gatewayPlebbit.createSubplebbit({ address: subplebbitAddress });
            expect(sub.updatedAt).to.be.undefined;

            let updateCount = 0;
            sub.on("update", () => updateCount++);

            let waitingRetryCount = 0;
            sub.on("updatingstatechange", (newState: string) => newState === "waiting-retry" && waitingRetryCount++);

            const emittedErrors: PlebbitError[] = [];
            sub.on("error", (error: PlebbitError | Error) => {
                emittedErrors.push(error as PlebbitError);
            });

            // Record states for verification
            const recordedStates: string[] = [];
            const gatewayUrl = Object.keys(sub.clients.ipfsGateways)[0];
            sub.clients.ipfsGateways[gatewayUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            await sub.update();

            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => waitingRetryCount >= 2,
                eventName: "updatingstatechange"
            });

            await sub.stop();
            expect(sub.updatedAt).to.be.undefined; // should not defined since signature is invalid

            // verifying states for the first correct update
            expect(recordedStates.slice(0, 2)).to.deep.equal(["fetching-ipns", "stopped"]);

            // verifying states for the first error
            expect(recordedStates.slice(2, 4)).to.deep.equal(["fetching-ipns", "stopped"]);

            // verifying states for the waiting retries, because it can't find a new record
            for (let i = 0; i < recordedStates.length; i += 2) {
                expect(recordedStates[i]).to.equal("fetching-ipns");
                expect(recordedStates[i + 1]).to.equal("stopped");
            }

            expect(emittedErrors.length).to.equal(1); // it's only a single emitted error since we never re-download an invalid record

            for (const emittedError of emittedErrors) {
                expect(emittedError.code).to.equal("ERR_FAILED_TO_FETCH_SUBPLEBBIT_FROM_GATEWAYS");
                expect((emittedError.details.gatewayToError["http://localhost:18080"] as PlebbitError).code).to.equal(
                    "ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID"
                );
            }

            expect(waitingRetryCount).to.be.greaterThan(0);
            expect(updateCount).to.equal(0); // no updatess because invalid signatures
        });
    });
});

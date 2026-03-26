import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";

import {
    publishRandomPost,
    getAvailablePlebbitConfigsToTestAgainst,
    mockGatewayPlebbit,
    createStaticSubplebbitRecordForComment,
    createMockedSubplebbitIpns
} from "../../../dist/node/test/test-util.js";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { PlebbitError } from "../../../dist/node/plebbit-error.js";
const subplebbitAddress = signers[0].address;

const clientsFieldName: Record<string, string> = {
    "remote-kubo-rpc": "kuboRpcClients",
    "remote-libp2pjs": "libp2pJsClients"
};

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    const clientFieldName = clientsFieldName[config.testConfigCode];
    describe(`subplebbit.clients.${clientFieldName} - ${config.name}`, async () => {
        let plebbit: PlebbitType;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`subplebbit.clients.${clientFieldName} is undefined for gateway plebbit`, async () => {
            const gatewayPlebbit = await mockGatewayPlebbit();
            const mockSub = await gatewayPlebbit.getSubplebbit({ address: subplebbitAddress });
            expect((mockSub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName]).to.be.undefined;
            await gatewayPlebbit.destroy();
        });

        it(`subplebbit.clients.${clientFieldName}[url] is stopped by default`, async () => {
            const mockSub = await plebbit.getSubplebbit({ address: subplebbitAddress });
            expect(Object.keys((mockSub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName]).length).to.equal(
                1
            );
            expect(
                (
                    Object.values((mockSub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0] as {
                        state: string;
                    }
                ).state
            ).to.equal("stopped");
        });

        it(`Correct order of ${clientFieldName} state when updating a sub that was created with plebbit.createSubplebbit({address})`, async () => {
            const sub = await plebbit.createSubplebbit({ address: signers[0].address });

            const expectedStates = ["fetching-ipns", "fetching-ipfs", "stopped"];

            const actualStates: string[] = [];

            const clientUrl = Object.keys((sub.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName])[0];

            (sub.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName][clientUrl].on(
                "statechange",
                (newState: string) => actualStates.push(newState)
            );

            const updatePromise = new Promise((resolve) => sub.once("update", resolve));
            await sub.update();
            await updatePromise;
            await sub.stop();

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of ${clientFieldName} state when updating a subplebbit that was created with plebbit.getSubplebbit({address: address})`, async () => {
            const sub = await plebbit.getSubplebbit({ address: signers[0].address });
            delete sub.raw.subplebbitIpfs;
            delete sub.updateCid;
            const expectedStates = ["fetching-ipns", "fetching-ipfs", "stopped"];

            const actualStates: string[] = [];

            const clientUrl = Object.keys((sub.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName])[0];

            (sub.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName][clientUrl].on(
                "statechange",
                (newState: string) => actualStates.push(newState)
            );

            const updatePromise = new Promise((resolve) => sub.once("update", resolve));
            await sub.update();
            await publishRandomPost({ communityAddress: sub.address, plebbit: plebbit }); // force an update
            await updatePromise;
            await sub.stop();

            expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);
        });

        it(`Correct order of ${clientFieldName} state when we update a subplebbit and it's not publishing new subplebbit records`, async () => {
            const subRecord = await createMockedSubplebbitIpns({}); // only published once, a static record

            const sub = await plebbit.createSubplebbit({ address: subRecord.communityAddress });

            const recordedStates: string[] = [];
            const clientUrl = Object.keys((sub.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName])[0];
            (sub.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName][clientUrl].on(
                "statechange",
                (newState: string) => recordedStates.push(newState)
            );

            // now plebbit._updatingSubplebbits will be defined

            const updatePromise = new Promise((resolve) => sub.once("update", resolve));
            await sub.update();
            await updatePromise;

            await new Promise((resolve) => setTimeout(resolve, plebbit.updateInterval * 4));

            await sub.stop();

            const expectedFirstStates = ["fetching-ipns", "fetching-ipfs", "stopped"]; // for first update

            expect(recordedStates.slice(0, expectedFirstStates.length)).to.deep.equal(expectedFirstStates);

            const noNewUpdateStates = recordedStates.slice(expectedFirstStates.length, recordedStates.length);

            // The rest should loop as ["fetching-ipns", "stopped"] because it can't find a new record
            expect(noNewUpdateStates.length % 2).to.equal(0);
            for (let i = 0; i < noNewUpdateStates.length; i += 2) {
                expect(noNewUpdateStates.slice(i, i + 2)).to.deep.equal(["fetching-ipns", "stopped"]);
            }
        });

        it(`Correct order of ${clientFieldName} client states when we attempt to update a subplebbit with invalid record`, async () => {
            const { commentCid, communityAddress: subplebbitAddress } = await createStaticSubplebbitRecordForComment({
                invalidateSubplebbitSignature: true
            });

            // Create a static subplebbit record with invalid signature
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });

            const recordedStates: string[] = [];
            const clientUrl = Object.keys((sub.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName])[0];
            (sub.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName][clientUrl].on(
                "statechange",
                (newState: string) => recordedStates.push(newState)
            );

            const errorPromise = new Promise<PlebbitError>((resolve) => sub.once("error", resolve as (err: Error) => void));

            await sub.update();
            const err = await errorPromise;
            await new Promise((resolve) => setTimeout(resolve, plebbit.updateInterval * 4));

            await sub.stop();
            expect(sub.updatedAt).to.be.undefined;
            expect(err.code).to.equal("ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID");

            const expectedFirstStates = ["fetching-ipns", "fetching-ipfs", "stopped"];
            expect(recordedStates.slice(0, expectedFirstStates.length)).to.deep.equal(expectedFirstStates);

            // Remaining states should loop as ["fetching-ipns", "stopped"] when it keeps failing
            const remainingStates = recordedStates.slice(expectedFirstStates.length);
            expect(remainingStates.length % 2).to.equal(0);
            for (let i = 0; i < remainingStates.length; i += 2) {
                expect(remainingStates.slice(i, i + 2)).to.deep.equal(["fetching-ipns", "stopped"]);
            }
        });
    });
});

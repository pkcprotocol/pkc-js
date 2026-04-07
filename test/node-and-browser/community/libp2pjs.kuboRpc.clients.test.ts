import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";

import {
    publishRandomPost,
    getAvailablePKCConfigsToTestAgainst,
    mockGatewayPKC,
    createStaticCommunityRecordForComment,
    createMockedCommunityIpns
} from "../../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
const communityAddress = signers[0].address;

const clientsFieldName: Record<string, string> = {
    "remote-kubo-rpc": "kuboRpcClients",
    "remote-libp2pjs": "libp2pJsClients"
};

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    const clientFieldName = clientsFieldName[config.testConfigCode];
    describe(`community.clients.${clientFieldName} - ${config.name}`, async () => {
        let pkc: PKCType;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`community.clients.${clientFieldName} is undefined for gateway pkc`, async () => {
            const gatewayPKC = await mockGatewayPKC();
            const mockSub = await gatewayPKC.getCommunity({ address: communityAddress });
            expect((mockSub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName]).to.be.undefined;
            await gatewayPKC.destroy();
        });

        it(`community.clients.${clientFieldName}[url] is stopped by default`, async () => {
            const mockSub = await pkc.getCommunity({ address: communityAddress });
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

        it(`Correct order of ${clientFieldName} state when updating a community that was created with pkc.createCommunity({address})`, async () => {
            const community = await pkc.createCommunity({ address: signers[0].address });

            const expectedStates = ["fetching-ipns", "fetching-ipfs", "stopped"];

            const actualStates: string[] = [];

            const clientUrl = Object.keys(
                (community.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName]
            )[0];

            (community.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName][clientUrl].on(
                "statechange",
                (newState: string) => actualStates.push(newState)
            );

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();
            await updatePromise;
            await community.stop();

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of ${clientFieldName} state when updating a community that was created with pkc.getCommunity({address: address})`, async () => {
            const community = await pkc.getCommunity({ address: signers[0].address });
            delete community.raw.communityIpfs;
            delete community.updateCid;
            const expectedStates = ["fetching-ipns", "fetching-ipfs", "stopped"];

            const actualStates: string[] = [];

            const clientUrl = Object.keys(
                (community.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName]
            )[0];

            (community.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName][clientUrl].on(
                "statechange",
                (newState: string) => actualStates.push(newState)
            );

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();
            await publishRandomPost({ communityAddress: community.address, pkc: pkc }); // force an update
            await updatePromise;
            await community.stop();

            expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);
        });

        it(`Correct order of ${clientFieldName} state when we update a community and it's not publishing new community records`, async () => {
            const subRecord = await createMockedCommunityIpns({}); // only published once, a static record

            const community = await pkc.createCommunity({ address: subRecord.communityAddress });

            const recordedStates: string[] = [];
            const clientUrl = Object.keys(
                (community.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName]
            )[0];
            (community.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName][clientUrl].on(
                "statechange",
                (newState: string) => recordedStates.push(newState)
            );

            // now pkc._updatingCommunities will be defined

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();
            await updatePromise;

            await new Promise((resolve) => setTimeout(resolve, pkc.updateInterval * 4));

            await community.stop();

            const expectedFirstStates = ["fetching-ipns", "fetching-ipfs", "stopped"]; // for first update

            expect(recordedStates.slice(0, expectedFirstStates.length)).to.deep.equal(expectedFirstStates);

            const noNewUpdateStates = recordedStates.slice(expectedFirstStates.length, recordedStates.length);

            // The rest should loop as ["fetching-ipns", "stopped"] because it can't find a new record
            expect(noNewUpdateStates.length % 2).to.equal(0);
            for (let i = 0; i < noNewUpdateStates.length; i += 2) {
                expect(noNewUpdateStates.slice(i, i + 2)).to.deep.equal(["fetching-ipns", "stopped"]);
            }
        });

        it(`Correct order of ${clientFieldName} client states when we attempt to update a community with invalid record`, async () => {
            const { commentCid, communityAddress: communityAddress } = await createStaticCommunityRecordForComment({
                invalidateCommunitySignature: true
            });

            // Create a static community record with invalid signature
            const community = await pkc.createCommunity({ address: communityAddress });

            const recordedStates: string[] = [];
            const clientUrl = Object.keys(
                (community.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName]
            )[0];
            (community.clients as unknown as Record<string, Record<string, { on: Function }>>)[clientFieldName][clientUrl].on(
                "statechange",
                (newState: string) => recordedStates.push(newState)
            );

            const errorPromise = new Promise<PKCError>((resolve) => community.once("error", resolve as (err: Error) => void));

            await community.update();
            const err = await errorPromise;
            await new Promise((resolve) => setTimeout(resolve, pkc.updateInterval * 4));

            await community.stop();
            expect(community.updatedAt).to.be.undefined;
            expect(err.code).to.equal("ERR_COMMUNITY_SIGNATURE_IS_INVALID");

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

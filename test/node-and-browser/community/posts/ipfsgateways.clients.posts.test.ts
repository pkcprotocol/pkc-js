import { beforeAll, afterAll } from "vitest";
import { getAvailablePlebbitConfigsToTestAgainst, addStringToIpfs } from "../../../../dist/node/test/test-util.js";

import signers from "../../../fixtures/signers.js";
import type { Plebbit as PlebbitType } from "../../../../dist/node/pkc/pkc.js";

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`subplebbit.posts.clients.ipfsGateways - ${config.name}`, async () => {
        let gatewayPlebbit: PlebbitType;
        beforeAll(async () => {
            gatewayPlebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await gatewayPlebbit.destroy();
        });

        it(`subplebbit.posts.clients.ipfsGateways[sortType][url] is stopped by default`, async () => {
            const mockSub = await gatewayPlebbit.getSubplebbit({ address: subplebbitAddress });
            const gatewayUrl = Object.keys(mockSub.clients.ipfsGateways)[0];
            // add tests here
            expect(Object.keys(mockSub.posts.clients.ipfsGateways["new"]).length).to.equal(1);
            expect(mockSub.posts.clients.ipfsGateways["new"][gatewayUrl].state).to.equal("stopped");
        });

        it(`Correct state of 'new' sort is updated after fetching from subplebbit.posts.pageCids.new`, async () => {
            const mockSub = await gatewayPlebbit.getSubplebbit({ address: subplebbitAddress });
            const firstPageMocked = {
                comments: mockSub.posts.pages.hot.comments.slice(0, 10).map((comment) => comment.raw)
            };
            const firstPageMockedCid = await addStringToIpfs(JSON.stringify(firstPageMocked));
            mockSub.posts.pageCids.new = firstPageMockedCid;

            const gatewayUrl = Object.keys(mockSub.clients.ipfsGateways)[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            mockSub.posts.clients.ipfsGateways["new"][gatewayUrl].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            await mockSub.posts.getPage({ cid: mockSub.posts.pageCids.new });
            expect(actualStates).to.deep.equal(expectedStates);
        });
    });
});

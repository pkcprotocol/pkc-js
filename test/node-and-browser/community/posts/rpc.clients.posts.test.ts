import { beforeAll, afterAll } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, addStringToIpfs } from "../../../../dist/node/test/test-util.js";
import signers from "../../../fixtures/signers.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-pkc-rpc"] }).map((config) => {
    describe(`community.posts.clients.plebbitRpcClients - ${config.name}`, async () => {
        let pkc: PKCType;

        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`community.posts.clients.plebbitRpcClients[sortType][url] is stopped by default`, async () => {
            const mockSub = await pkc.getCommunity({ address: communityAddress });
            const rpcUrl = Object.keys(mockSub.clients.plebbitRpcClients)[0];
            // add tests here
            expect(Object.keys(mockSub.posts.clients.plebbitRpcClients["new"]).length).to.equal(1);
            expect(mockSub.posts.clients.plebbitRpcClients["new"][rpcUrl].state).to.equal("stopped");
        });

        it(`Correct state of 'new' sort is updated after fetching from community.posts.pageCids.new`, async () => {
            const mockSub = await pkc.getCommunity({ address: communityAddress });
            const firstPageMocked = {
                comments: mockSub.posts.pages.hot.comments.slice(0, 10).map((comment) => comment.raw)
            };
            const firstPageMockedCid = await addStringToIpfs(JSON.stringify(firstPageMocked));
            mockSub.posts.pageCids.new = firstPageMockedCid;
            const rpcUrl = Object.keys(mockSub.clients.plebbitRpcClients)[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            mockSub.posts.clients.plebbitRpcClients["new"][rpcUrl].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            await mockSub.posts.getPage({ cid: mockSub.posts.pageCids.new });
            expect(actualStates).to.deep.equal(expectedStates);
        });
    });
});

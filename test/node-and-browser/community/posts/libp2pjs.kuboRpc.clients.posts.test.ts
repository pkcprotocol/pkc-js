import { beforeAll, afterAll } from "vitest";
import signers from "../../../fixtures/signers.js";

import {
    describeSkipIfRpc,
    mockGatewayPKC,
    getAvailablePKCConfigsToTestAgainst,
    addStringToIpfs
} from "../../../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";

const subplebbitAddress = signers[0].address;

const clientsFieldName: Record<string, string> = {
    "remote-kubo-rpc": "kuboRpcClients",
    "remote-libp2pjs": "libp2pJsClients"
};

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    const clientFieldName = clientsFieldName[config.testConfigCode];
    describeSkipIfRpc(`subplebbit.posts.clients.${clientFieldName} - ${config.name}`, async () => {
        let plebbit: PKCType;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`subplebbit.posts.clients.${clientFieldName} is undefined for gateway plebbit`, async () => {
            const gatewayPKC = await mockGatewayPKC();
            const mockSub = await gatewayPKC.createCommunity({ address: subplebbitAddress });
            const sortTypes = Object.keys(
                (mockSub.posts.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                    clientFieldName
                ]
            );
            expect(sortTypes.length).to.be.greaterThan(0);
            for (const sortType of sortTypes)
                expect(
                    (mockSub.posts.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                        clientFieldName
                    ][sortType]
                ).to.deep.equal({});
            await gatewayPKC.destroy();
        });

        it(`subplebbit.posts.clients.${clientFieldName}[sortType][url] is stopped by default`, async () => {
            const mockSub = await plebbit.createCommunity({ address: subplebbitAddress });
            const key = Object.keys((mockSub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];
            // add tests here
            expect(
                Object.keys(
                    (mockSub.posts.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                        clientFieldName
                    ]["new"]
                ).length
            ).to.equal(1);
            expect(
                (
                    (mockSub.posts.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                        clientFieldName
                    ]["new"][key] as { state: string }
                ).state
            ).to.equal("stopped");
        });

        it(`Correct state of 'new' sort is updated after fetching from subplebbit.posts.pageCids.new`, async () => {
            const mockSub = await plebbit.getCommunity({ address: subplebbitAddress });
            const firstPageMocked = {
                comments: mockSub.posts.pages.hot.comments.slice(0, 10).map((comment) => comment.raw)
            };

            const firstPageMockedCid = await addStringToIpfs(JSON.stringify(firstPageMocked));

            mockSub.posts.pageCids.new = firstPageMockedCid;

            const clientKey = Object.keys((mockSub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            (mockSub.posts.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                clientFieldName
            ]["new"][clientKey].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            await mockSub.posts.getPage({ cid: mockSub.posts.pageCids.new });
            expect(actualStates).to.deep.equal(expectedStates);
        });

        it("Correct state of 'new' sort is updated after fetching second page of 'new' pages", async () => {
            const mockSub = await plebbit.getCommunity({ address: subplebbitAddress });
            const clientKey = Object.keys((mockSub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];

            const secondPageMocked = { comments: mockSub.posts.pages.hot.comments.slice(1, 5).map((comment) => comment.raw) }; // create a slightly different page
            const secondPageCid = await addStringToIpfs(JSON.stringify(secondPageMocked));

            const firstPageMocked = {
                comments: mockSub.posts.pages.hot.comments.slice(0, 10).map((comment) => comment.raw),
                nextCid: secondPageCid
            };

            const firstPageMockedCid = await addStringToIpfs(JSON.stringify(firstPageMocked));

            mockSub.posts.pageCids.new = firstPageMockedCid;

            const expectedStates = ["fetching-ipfs", "stopped", "fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            (mockSub.posts.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                clientFieldName
            ]["new"][clientKey].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            const newFirstPage = await mockSub.posts.getPage({ cid: mockSub.posts.pageCids.new });
            expect(newFirstPage.nextCid).to.be.a("string");
            await mockSub.posts.getPage({ cid: newFirstPage.nextCid });

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct state of 'new' sort is updated after fetching with a subplebbit created with plebbit.createCommunity({address, pageCids})`, async () => {
            const remotePKC = await config.plebbitInstancePromise();
            const mockSub = await remotePKC.getCommunity({ address: subplebbitAddress });

            const firstPageMocked = {
                comments: mockSub.posts.pages.hot.comments.slice(0, 10).map((comment) => comment.raw)
            };

            const firstPageMockedCid = await addStringToIpfs(JSON.stringify(firstPageMocked));

            const fetchSub = await remotePKC.createCommunity({
                address: subplebbitAddress,
                posts: { pageCids: { ...mockSub.posts.pageCids, new: firstPageMockedCid } }
            });
            expect(fetchSub.updatedAt).to.be.undefined;

            const clientKey = Object.keys((fetchSub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            (fetchSub.posts.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                clientFieldName
            ]["new"][clientKey].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            await fetchSub.posts.getPage({ cid: fetchSub.posts.pageCids.new });
            expect(actualStates).to.deep.equal(expectedStates);
            await remotePKC.destroy();
        });
    });
});

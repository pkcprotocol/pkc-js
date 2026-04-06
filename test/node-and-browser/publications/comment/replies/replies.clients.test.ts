import { beforeAll, afterAll, describe, it } from "vitest";
import signers from "../../../../fixtures/signers.js";
import {
    mockGatewayPlebbit,
    getRandomPostCidFromSub,
    resolveWhenConditionIsTrue,
    addStringToIpfs,
    getAvailablePlebbitConfigsToTestAgainst
} from "../../../../../dist/node/test/test-util.js";
import type { Plebbit } from "../../../../../dist/node/pkc/pkc.js";
const subplebbitAddress = signers[0].address;

const clientsFieldName: Record<string, string> = {
    "remote-libp2pjs": "libp2pJsClients",
    "remote-kubo-rpc": "kuboRpcClients"
};
getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    const clientFieldName = clientsFieldName[config.testConfigCode];
    describe(`comment.replies.clients.${clientFieldName} - ${config.name}`, async () => {
        let plebbit: Plebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`comment.replies.clients.${clientFieldName} is {} for gateway plebbit`, async () => {
            const gatewayPlebbit = await mockGatewayPlebbit();
            const comment = await gatewayPlebbit.getComment({ cid: await getRandomPostCidFromSub(subplebbitAddress, plebbit) });
            const sortTypes = Object.keys((comment.replies.clients as Record<string, Record<string, unknown>>)[clientFieldName]);
            expect(sortTypes.length).to.be.greaterThan(0);

            for (const sortType of sortTypes)
                expect((comment.replies.clients as Record<string, Record<string, unknown>>)[clientFieldName][sortType]).to.deep.equal({}); // should be empty
            await gatewayPlebbit.destroy();
        });
        it(`comment.replies.clients.${clientFieldName}[sortType][url] is stopped by default`, async () => {
            const comment = await plebbit.getComment({ cid: await getRandomPostCidFromSub(subplebbitAddress, plebbit) });
            const ipfsUrl = Object.keys((comment.clients as Record<string, Record<string, unknown>>)[clientFieldName])[0];
            expect(
                Object.keys((comment.replies.clients as Record<string, Record<string, Record<string, unknown>>>)[clientFieldName]["new"])
                    .length
            ).to.equal(1);
            expect(
                (comment.replies.clients as Record<string, Record<string, Record<string, { state: string }>>>)[clientFieldName]["new"][
                    ipfsUrl
                ].state
            ).to.equal("stopped");
        });

        it(`Correct state of 'new' sort is updated after fetching from comment.replies.pageCids.new`, async () => {
            const comment = await plebbit.getComment({ cid: await getRandomPostCidFromSub(subplebbitAddress, plebbit) });
            comment.replies.pageCids.new = "QmUrxBiaphUt3K6qDs2JspQJAgm34sKQaa5YaRmyAWXN4D"; // random cid
            const ipfsUrl = Object.keys((comment.clients as Record<string, Record<string, unknown>>)[clientFieldName])[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            (
                comment.replies.clients as Record<
                    string,
                    Record<string, Record<string, { on: (event: string, handler: (state: string) => void) => void }>>
                >
            )[clientFieldName]["new"][ipfsUrl].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            const originalTimeout = plebbit._timeouts["page-ipfs"];
            plebbit._timeouts["page-ipfs"] = 100;
            try {
                await comment.replies.getPage({ cid: comment.replies.pageCids.new }); // it will fail because it's not a real page
            } catch {}
            expect(actualStates).to.deep.equal(expectedStates);
            plebbit._timeouts["page-ipfs"] = originalTimeout; // Reset timeout
        });
    });
});

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`comment.replies.clients.ipfsGateways - ${config.name}`, async () => {
        let plebbit: Plebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });
        it(`comment.replies.clients.ipfsGateways[sortType][url] is stopped by default`, async () => {
            const comment = await plebbit.getComment({ cid: await getRandomPostCidFromSub(subplebbitAddress, plebbit) });
            const gatewayUrl = Object.keys(comment.clients.ipfsGateways)[0];
            // add tests here
            expect(Object.keys(comment.replies.clients.ipfsGateways["new"]).length).to.equal(1);
            expect(comment.replies.clients.ipfsGateways["new"][gatewayUrl].state).to.equal("stopped");
        });

        it(`Correct state of 'new' sort is updated after fetching from comment.replies.pageCids.new`, async () => {
            const comment = await plebbit.getComment({ cid: await getRandomPostCidFromSub(subplebbitAddress, plebbit) });
            comment.replies.pageCids.new = "QmUrxBiaphUt3K6qDs2JspQJAgm34sKQaa5YaRmyAWXN4D"; // random cid

            const gatewayUrl = Object.keys(comment.clients.ipfsGateways)[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            comment.replies.clients.ipfsGateways["new"][gatewayUrl].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            const originalTimeout = plebbit._timeouts["page-ipfs"];
            plebbit._timeouts["page-ipfs"] = 100;
            try {
                await comment.replies.getPage({ cid: comment.replies.pageCids.new });
            } catch {}
            expect(actualStates).to.deep.equal(expectedStates);
            plebbit._timeouts["page-ipfs"] = originalTimeout; // Reset timeout
        });

        it(`Correct state of 'new' sort is correct after fetching from responsive and unresponsive gateway `, async () => {
            // RPC exception
            const gateways = [
                "http://localhost:13417", // This gateway will take 10s to respond
                "http://localhost:18080" // This one is immediate
            ];
            const multipleGatewayPlebbit = await mockGatewayPlebbit({
                plebbitOptions: {
                    ipfsGatewayUrls: gateways,
                    httpRoutersOptions: [],
                    dataPath: undefined
                }
            });

            const comment = await multipleGatewayPlebbit.getComment({ cid: await getRandomPostCidFromSub(subplebbitAddress, plebbit) });
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
            const mockedPageIpfs = await addStringToIpfs(JSON.stringify({ comments: [comment.raw] })); // wrong schema, but goal is to test for states
            comment.replies.pageCids.new = mockedPageIpfs; // random cid

            const expectedStates = {
                [gateways[0]]: [
                    "fetching-ipfs",
                    "stopped" // It stopped after fetching the IPFS
                ],
                [gateways[1]]: [
                    "fetching-ipfs",
                    "stopped" // It stopped after it was aborted
                ]
            };

            const actualStates: Record<string, string[]> = { [gateways[0]]: [], [gateways[1]]: [] };
            for (const gatewayUrl of gateways)
                comment.replies.clients.ipfsGateways["new"][gatewayUrl].on("statechange", (newState: string) => {
                    actualStates[gatewayUrl].push(newState);
                });

            multipleGatewayPlebbit._timeouts["page-ipfs"] = 2 * 1000; // Change timeout to 2s
            const timeBefore = Date.now();
            try {
                await comment.replies.getPage({ cid: comment.replies.pageCids.new });
            } catch {}
            const timeItTookInMs = Date.now() - timeBefore;
            expect(timeItTookInMs).to.be.lessThan(9000);

            expect(actualStates).to.deep.equal(expectedStates);
        });
    });
});

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-plebbit-rpc"] }).map((config) => {
    describe(`comment.replies.clients.plebbitRpcClients - ${config.name}`, async () => {
        let plebbit: Plebbit;
        let commentCid: string;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            const subplebbit = await plebbit.getSubplebbit({ address: subplebbitAddress });
            commentCid = subplebbit.posts.pages.hot.comments[0].cid;
            expect(commentCid).to.be.a("string");
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`comment.replies.clients.plebbitRpcClients[sortType][url] is stopped by default`, async () => {
            const comment = await plebbit.getComment({ cid: commentCid });
            const rpcUrl = Object.keys(comment.clients.plebbitRpcClients)[0];
            // add tests here
            expect(Object.keys(comment.replies.clients.plebbitRpcClients["new"]).length).to.equal(1);
            expect(comment.replies.clients.plebbitRpcClients["new"][rpcUrl].state).to.equal("stopped");
        });

        it(`Correct state of 'new' sort is updated after fetching from comment.replies.pageCids.new`, async () => {
            const comment = await plebbit.getComment({ cid: commentCid });
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

            const rpcUrl = Object.keys(comment.clients.plebbitRpcClients)[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            comment.replies.clients.plebbitRpcClients["new"][rpcUrl].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            comment.replies.pageCids.new = await addStringToIpfs("12345");
            try {
                await comment.replies.getPage({ cid: comment.replies.pageCids.new }); // it will fail because it's not a real page
            } catch {}
            await comment.stop();
            expect(actualStates).to.deep.equal(expectedStates);
        });
    });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import signers from "../../fixtures/signers.js";
import communityRecordFixture from "../../fixtures/signatures/community/valid_community_ipfs_new_format.json" with { type: "json" };
import { mockGatewayPKC, mockPKCNoDataPathWithOnlyKuboClient, mockPKCV2 } from "../../../dist/node/test/test-util.js";
import { PostsPages } from "../../../dist/node/pages/pages.js";
import Logger from "../../../dist/node/logger.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { CommunityIpfsType } from "../../../dist/node/community/types.js";
import type { PageIpfs } from "../../../dist/node/pages/types.js";
import type { OptionsToLoadFromGateway } from "../../../dist/node/clients/base-client-manager.js";

// The per-sort page client states (community.posts.clients.<transport>[sortType][url].state) bracket each page fetch with
// fetching-ipfs -> stopped.

const pageCidOf = async (label: string) => CID.createV0(await sha256.digest(new TextEncoder().encode(label))).toString();

describe("page client states while a page is fetched", () => {
    let pkc: PKC | undefined;

    afterEach(async () => {
        vi.restoreAllMocks();
        if (pkc) await pkc.destroy();
        pkc = undefined;
    });

    // _fetchPageWithRpc returned the RPC request without awaiting it inside try/finally, so the finally set the state
    // back to "stopped" in the same tick it was set to "fetching-ipfs", while the request was still in flight.
    it("over RPC, the sort's rpc client stays fetching-ipfs until the page request settles", async () => {
        pkc = await mockPKCV2({
            stubStorage: true,
            remotePKC: true,
            mockResolve: false,
            // pkcRpcClientsOptions: undefined keeps this PKC offline when USE_RPC=1, where mockPKCV2 would connect to the RPC server
            pkcOptions: {
                pkcRpcClientsOptions: undefined,
                kuboRpcClientsOptions: [],
                pubsubKuboRpcClientsOptions: [],
                httpRoutersOptions: []
            }
        });
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        const pageCid = await pageCidOf("rpc page");

        // The transport is stubbed below the pages client manager: a PKC view that routes page requests to an RPC
        // client whose getCommunityPage answers only when the test says so. Nothing connects anywhere.
        const rpcUrl = "ws://localhost:9138";
        let answerPageRequest!: (result: { page: PageIpfs }) => void;
        const getCommunityPage = vi.fn(() => new Promise<{ page: PageIpfs }>((resolve) => (answerPageRequest = resolve)));
        const rpcPkc: PKC = Object.assign(Object.create(pkc) as PKC, {
            pkcRpcClientsOptions: [rpcUrl],
            _pkcRpcClient: { getCommunityPage },
            clients: { ...pkc.clients, pkcRpcClients: { [rpcUrl]: {} } }
        });
        const posts = new PostsPages({ pkc: rpcPkc, community, pageCids: { hot: pageCid }, pages: {} });
        const hotRpcClient = posts.clients.pkcRpcClients.hot[rpcUrl];
        const states: string[] = [];
        hotRpcClient.on("statechange", (state) => states.push(state));

        const pagePromise = posts.getPage({ cid: pageCid });
        await vi.waitFor(() => expect(getCommunityPage).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setImmediate(resolve)); // let any pending settle callbacks run

        expect(hotRpcClient.state).toBe("fetching-ipfs");
        expect(states).toEqual(["fetching-ipfs"]);

        answerPageRequest({ page: { comments: [] } });
        const page = await pagePromise;

        expect(page.comments).toEqual([]);
        expect(hotRpcClient.state).toBe("stopped");
        expect(states).toEqual(["fetching-ipfs", "stopped"]);
    });
});

// pkc._memCaches.pageCidToSortTypes is shared by every instance of a PKC, but an instance seeds its per-sort client states
// only for the built-in sorts and the pageCids of a record it holds. An app that starts from a cached community hits the gap:
// the cached record puts a custom sort's page cid (settings.pages) in the shared cache, and the instance the app then creates
// from the address alone to fetch that page has no record yet, because no updating instance has loaded one. Reading the
// missing sort's client state threw a TypeError before anything was fetched.
describe("page client states for a sort the instance has not seen", () => {
    const customSort = "topAllTimeByAwards";
    let pkc: PKC | undefined;

    afterEach(async () => {
        vi.restoreAllMocks();
        if (pkc) await pkc.destroy();
        pkc = undefined;
    });

    // What an app holds from its last session: a community record whose posts have a page under a custom sort
    const cachedRecordWithCustomSort = async () => {
        const pageCid = await pageCidOf("custom sort page");
        const record = structuredClone(communityRecordFixture) as CommunityIpfsType;
        record.posts = { pages: {}, pageCids: { [customSort]: pageCid } };
        return { record, pageCid };
    };

    it("getPage fetches the page on an instance created from the address alone", async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient({ pkcOptions: { httpRoutersOptions: [] } });
        const { record, pageCid } = await cachedRecordWithCustomSort();
        const fromCachedRecord = (await pkc.createCommunity(record)) as RemoteCommunity;
        expect(pkc._memCaches.pageCidToSortTypes.get(pageCid)).toEqual([customSort]);

        const fromAddress = (await pkc.createCommunity({ address: fromCachedRecord.address })) as RemoteCommunity;
        expect(fromAddress.raw.communityIpfs).toBeUndefined();
        expect(fromAddress.posts.clients.kuboRpcClients[customSort]).toBeUndefined();
        const fetchSpy = vi
            .spyOn(fromAddress.posts._clientsManager, "_fetchCidP2P")
            .mockImplementation(async () => JSON.stringify({ comments: [] } satisfies PageIpfs));
        const kuboUrl = Object.keys(pkc.clients.kuboRpcClients)[0];

        const page = await fromAddress.posts.getPage({ cid: pageCid });

        expect(page.comments).toEqual([]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fromAddress.posts.clients.kuboRpcClients[customSort][kuboUrl].state).toBe("stopped");
    });

    it("over RPC, getPage requests the page on an instance that has no pageCids", async () => {
        pkc = await mockPKCV2({
            stubStorage: true,
            remotePKC: true,
            mockResolve: false,
            // pkcRpcClientsOptions: undefined keeps this PKC offline when USE_RPC=1, where mockPKCV2 would connect to the RPC server
            pkcOptions: {
                pkcRpcClientsOptions: undefined,
                kuboRpcClientsOptions: [],
                pubsubKuboRpcClientsOptions: [],
                httpRoutersOptions: []
            }
        });
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        const pageCid = await pageCidOf("custom sort page over rpc");
        const rpcUrl = "ws://localhost:9138";
        const getCommunityPage = vi.fn(async (): Promise<{ page: PageIpfs }> => ({ page: { comments: [] } }));
        const rpcPkc: PKC = Object.assign(Object.create(pkc) as PKC, {
            pkcRpcClientsOptions: [rpcUrl],
            _pkcRpcClient: { getCommunityPage },
            clients: { ...pkc.clients, pkcRpcClients: { [rpcUrl]: {} } }
        });
        // One pages object learns the custom sort from its pageCids, which caches the cid under it for the whole PKC
        new PostsPages({ pkc: rpcPkc, community, pageCids: { [customSort]: pageCid }, pages: {} });
        const posts = new PostsPages({ pkc: rpcPkc, community, pageCids: {}, pages: {} });
        expect(posts.clients.pkcRpcClients[customSort]).toBeUndefined();

        const page = await posts.getPage({ cid: pageCid });

        expect(page.comments).toEqual([]);
        expect(getCommunityPage).toHaveBeenCalledTimes(1);
        expect(posts.clients.pkcRpcClients[customSort][rpcUrl].state).toBe("stopped");
    });

    it("the gateway fetch hooks set the state of an instance created from the address alone", async () => {
        pkc = await mockGatewayPKC({ pkcOptions: { httpRoutersOptions: [] } });
        const { record, pageCid } = await cachedRecordWithCustomSort();
        const fromCachedRecord = (await pkc.createCommunity(record)) as RemoteCommunity;
        const fromAddress = (await pkc.createCommunity({ address: fromCachedRecord.address })) as RemoteCommunity;
        expect(fromAddress.posts.clients.ipfsGateways[customSort]).toBeUndefined();
        const gatewayUrl = Object.keys(pkc.clients.ipfsGateways)[0];
        // What _fetchWithGateway passes to the gateway hooks around one fetch
        const loadOpts: OptionsToLoadFromGateway = {
            root: pageCid,
            recordIpfsType: "ipfs",
            recordPKCType: "page-ipfs",
            maxFileSizeBytes: 1024 * 1024,
            timeoutMs: 60000,
            abortController: new AbortController(),
            validateGatewayResponseFunc: async () => {},
            log: Logger("pkc-js:test:pages-client-states")
        };

        fromAddress.posts._clientsManager.preFetchGateway(gatewayUrl, loadOpts);
        expect(fromAddress.posts.clients.ipfsGateways[customSort][gatewayUrl].state).toBe("fetching-ipfs");

        fromAddress.posts._clientsManager.postFetchGatewaySuccess(gatewayUrl, loadOpts);
        expect(fromAddress.posts.clients.ipfsGateways[customSort][gatewayUrl].state).toBe("stopped");
    });

    it("the libp2p-js state setter seeds a sort it is handed for the first time", async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient({ pkcOptions: { httpRoutersOptions: [] } });
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        // A PKC view with one libp2p-js client entry, so no helia node has to start for a state-only check
        const libp2pJsClientKey = "libp2pjs-test-client";
        const libp2pJsPkc: PKC = Object.assign(Object.create(pkc) as PKC, {
            clients: { ...pkc.clients, libp2pJsClients: { [libp2pJsClientKey]: {} } }
        });
        const posts = new PostsPages({ pkc: libp2pJsPkc, community, pageCids: {}, pages: {} });
        expect(posts.clients.libp2pJsClients[customSort]).toBeUndefined();

        posts._clientsManager.updateLibp2pJsClientState("fetching-ipfs", libp2pJsClientKey, [customSort]);
        expect(posts.clients.libp2pJsClients[customSort][libp2pJsClientKey].state).toBe("fetching-ipfs");

        posts._clientsManager.updateLibp2pJsClientState("stopped", libp2pJsClientKey, [customSort]);
        expect(posts.clients.libp2pJsClients[customSort][libp2pJsClientKey].state).toBe("stopped");
    });
});

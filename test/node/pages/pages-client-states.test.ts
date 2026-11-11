import { afterEach, describe, expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import signers from "../../fixtures/signers.js";
import { mockGatewayPKC, mockPKCNoDataPathWithOnlyKuboClient, mockPKCV2 } from "../../../dist/node/test/test-util.js";
import { PostsPages } from "../../../dist/node/pages/pages.js";
import Logger from "../../../dist/node/logger.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { PageIpfs } from "../../../dist/node/pages/types.js";
import type { OptionsToLoadFromGateway } from "../../../dist/node/clients/base-client-manager.js";

// The per-sort page client states (community.posts.clients.<transport>[sortType][url].state) bracket each page fetch with
// fetching-ipfs -> stopped. Concurrent fetches under one sort share that state, which stops with the last of them.

const pageCidOf = async (label: string) => CID.createV0(await sha256.digest(new TextEncoder().encode(label))).toString();

// What _fetchWithGateway passes to the gateway hooks: one object per gateway fetch
const gatewayLoadOptsFor = (root: string): OptionsToLoadFromGateway => ({
    root,
    recordIpfsType: "ipfs",
    recordPKCType: "page-ipfs",
    maxFileSizeBytes: 1024 * 1024,
    timeoutMs: 60000,
    abortController: new AbortController(),
    validateGatewayResponseFunc: async () => {},
    log: Logger("pkc-js:test:pages-client-states")
});

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

    // pkc._memCaches.pageCidToSortTypes is shared by every instance, but each instance seeds its per-sort client states
    // only for the built-in sorts and its own pageCids. A cid that another instance cached under a custom sort
    // (settings.pages) made getPage on an instance without that sort throw a TypeError before fetching anything.
    it("getPage on an instance that never saw the custom sort a cid is cached under fetches the page", async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient({ pkcOptions: { httpRoutersOptions: [] } });
        const pageCid = await pageCidOf("custom sort page");
        const customSort = "topAllTimeByAwards";

        // Instance A holds a record whose posts use a custom sort, which caches pageCid under it pkc-wide
        const a = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        a.posts.updateProps({ community: a, pageCids: { [customSort]: pageCid }, pages: {} });
        expect(pkc._memCaches.pageCidToSortTypes.get(pageCid)).toEqual([customSort]);

        // Instance B of the same community was created without a record, so its posts know no pageCids
        const b = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        expect(b.posts.clients.kuboRpcClients[customSort]).toBeUndefined();
        const fetchSpy = vi
            .spyOn(b.posts._clientsManager, "_fetchCidP2P")
            .mockImplementation(async () => JSON.stringify({ comments: [] } satisfies PageIpfs));

        const page = await b.posts.getPage({ cid: pageCid });

        expect(page.comments).toEqual([]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const kuboUrl = Object.keys(pkc.clients.kuboRpcClients)[0];
        expect(b.posts.clients.kuboRpcClients[customSort][kuboUrl].state).toBe("stopped");
    });

    // Each fetch set its sorts to "stopped" when it settled, so with two fetches under one sort in flight the first to
    // settle reported "stopped" while the other was still fetching.
    it("two page fetches under one sort keep its kubo client fetching-ipfs until the last one settles", async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient({ pkcOptions: { httpRoutersOptions: [] } });
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        const pageCid = await pageCidOf("hot page");
        community.posts.updateProps({ community, pageCids: { hot: pageCid }, pages: {} });

        const answerFetches: ((pageJson: string) => void)[] = [];
        vi.spyOn(community.posts._clientsManager, "_fetchCidP2P").mockImplementation(
            () => new Promise<string>((resolve) => answerFetches.push(resolve))
        );
        const kuboUrl = Object.keys(pkc.clients.kuboRpcClients)[0];
        const hotKuboClient = community.posts.clients.kuboRpcClients.hot[kuboUrl];
        const states: string[] = [];
        hotKuboClient.on("statechange", (state) => states.push(state));

        const firstPage = community.posts.getPage({ cid: pageCid });
        const secondPage = community.posts.getPage({ cid: pageCid });
        await vi.waitFor(() => expect(answerFetches).toHaveLength(2));
        expect(hotKuboClient.state).toBe("fetching-ipfs");

        answerFetches[0](JSON.stringify({ comments: [] } satisfies PageIpfs));
        await firstPage;
        expect(hotKuboClient.state).toBe("fetching-ipfs");

        answerFetches[1](JSON.stringify({ comments: [] } satisfies PageIpfs));
        await secondPage;
        expect(hotKuboClient.state).toBe("stopped");
        expect(states).toEqual(["fetching-ipfs", "stopped"]);
    });

    // _fetchWithGateway can call postFetchGatewaySuccess and then postFetchGatewayFailure for one fetch (a throw after the
    // success hook lands in its catch), so a fetch must release its sorts once, not once per hook.
    it("a gateway fetch releases its sorts once, even when both post-fetch hooks run for it", async () => {
        pkc = await mockGatewayPKC({ pkcOptions: { httpRoutersOptions: [] } });
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        const pageCid = await pageCidOf("gateway page");
        community.posts.updateProps({ community, pageCids: { hot: pageCid }, pages: {} });
        const clientsManager = community.posts._clientsManager;
        const gatewayUrl = Object.keys(pkc.clients.ipfsGateways)[0];
        const hotGatewayClient = community.posts.clients.ipfsGateways.hot[gatewayUrl];

        const firstFetch = gatewayLoadOptsFor(pageCid);
        const secondFetch = gatewayLoadOptsFor(pageCid);
        clientsManager.preFetchGateway(gatewayUrl, firstFetch);
        clientsManager.preFetchGateway(gatewayUrl, secondFetch);
        expect(hotGatewayClient.state).toBe("fetching-ipfs");

        clientsManager.postFetchGatewaySuccess(gatewayUrl, firstFetch);
        clientsManager.postFetchGatewayFailure(gatewayUrl, firstFetch);
        expect(hotGatewayClient.state).toBe("fetching-ipfs");

        clientsManager.postFetchGatewaySuccess(gatewayUrl, secondFetch);
        expect(hotGatewayClient.state).toBe("stopped");
    });

    // The gateway hooks read the sorts from the shared cid cache before and after the fetch, so a cid that left the cache
    // (LRU eviction, max 5000 entries) during a fetch left its sorts at "fetching-ipfs".
    it("a gateway fetch stops the sorts it started, even if the cid left the shared cache meanwhile", async () => {
        pkc = await mockGatewayPKC({ pkcOptions: { httpRoutersOptions: [] } });
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        const pageCid = await pageCidOf("evicted page");
        community.posts.updateProps({ community, pageCids: { hot: pageCid }, pages: {} });
        const clientsManager = community.posts._clientsManager;
        const gatewayUrl = Object.keys(pkc.clients.ipfsGateways)[0];
        const hotGatewayClient = community.posts.clients.ipfsGateways.hot[gatewayUrl];

        const fetch = gatewayLoadOptsFor(pageCid);
        clientsManager.preFetchGateway(gatewayUrl, fetch);
        expect(hotGatewayClient.state).toBe("fetching-ipfs");

        pkc._memCaches.pageCidToSortTypes.delete(pageCid);
        clientsManager.postFetchGatewaySuccess(gatewayUrl, fetch);
        expect(hotGatewayClient.state).toBe("stopped");
    });
});

// A fetch counts itself in flight under its sorts before the "fetching-ipfs" statechange is emitted. If a consumer's
// listener throws on that emit, the fetch fails, and it must still release its count; otherwise the sort's client stays
// "fetching-ipfs" for the instance's lifetime, because every later fetch only moves the count between 2 and 1.
describe("page client states after a statechange listener throws on fetching-ipfs", () => {
    let pkc: PKC | undefined;
    const listenerError = new Error("statechange listener failed");
    const throwOnFetching = (state: string) => {
        if (state === "fetching-ipfs") throw listenerError;
    };

    afterEach(async () => {
        vi.restoreAllMocks();
        if (pkc) await pkc.destroy();
        pkc = undefined;
    });

    it("the failed kubo fetch releases its sort, so the next fetch ends stopped", async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient({ pkcOptions: { httpRoutersOptions: [] } });
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        const pageCid = await pageCidOf("kubo page, throwing listener");
        community.posts.updateProps({ community, pageCids: { hot: pageCid }, pages: {} });
        vi.spyOn(community.posts._clientsManager, "_fetchCidP2P").mockImplementation(async () =>
            JSON.stringify({ comments: [] } satisfies PageIpfs)
        );
        const kuboUrl = Object.keys(pkc.clients.kuboRpcClients)[0];
        const hotKuboClient = community.posts.clients.kuboRpcClients.hot[kuboUrl];

        hotKuboClient.on("statechange", throwOnFetching);
        await expect(community.posts.getPage({ cid: pageCid })).rejects.toThrow(listenerError.message);
        hotKuboClient.removeListener("statechange", throwOnFetching);

        const page = await community.posts.getPage({ cid: pageCid });
        expect(page.comments).toEqual([]);
        expect(hotKuboClient.state).toBe("stopped");
    });

    // _fetchWithGateway calls preFetchGateway outside its try, so no post-fetch hook runs for a fetch whose pre hook threw
    it("a gateway pre-fetch hook that throws releases the sorts it counted", async () => {
        pkc = await mockGatewayPKC({ pkcOptions: { httpRoutersOptions: [] } });
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        const pageCid = await pageCidOf("gateway page, throwing listener");
        community.posts.updateProps({ community, pageCids: { hot: pageCid }, pages: {} });
        const clientsManager = community.posts._clientsManager;
        const gatewayUrl = Object.keys(pkc.clients.ipfsGateways)[0];
        const hotGatewayClient = community.posts.clients.ipfsGateways.hot[gatewayUrl];

        hotGatewayClient.on("statechange", throwOnFetching);
        expect(() => clientsManager.preFetchGateway(gatewayUrl, gatewayLoadOptsFor(pageCid))).toThrow(listenerError);
        hotGatewayClient.removeListener("statechange", throwOnFetching);

        const fetch = gatewayLoadOptsFor(pageCid);
        clientsManager.preFetchGateway(gatewayUrl, fetch);
        expect(hotGatewayClient.state).toBe("fetching-ipfs");
        clientsManager.postFetchGatewaySuccess(gatewayUrl, fetch);
        expect(hotGatewayClient.state).toBe("stopped");
    });

    it("the failed RPC page request releases its sort, so the next request ends stopped", async () => {
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
        const pageCid = await pageCidOf("rpc page, throwing listener");

        // Same stubbed RPC transport as the RPC test above, answering every page request at once
        const rpcUrl = "ws://localhost:9138";
        const getCommunityPage = vi.fn(async () => ({ page: { comments: [] } satisfies PageIpfs }));
        const rpcPkc: PKC = Object.assign(Object.create(pkc) as PKC, {
            pkcRpcClientsOptions: [rpcUrl],
            _pkcRpcClient: { getCommunityPage },
            clients: { ...pkc.clients, pkcRpcClients: { [rpcUrl]: {} } }
        });
        const posts = new PostsPages({ pkc: rpcPkc, community, pageCids: { hot: pageCid }, pages: {} });
        const hotRpcClient = posts.clients.pkcRpcClients.hot[rpcUrl];

        hotRpcClient.on("statechange", throwOnFetching);
        await expect(posts.getPage({ cid: pageCid })).rejects.toThrow(listenerError.message);
        hotRpcClient.removeListener("statechange", throwOnFetching);

        const page = await posts.getPage({ cid: pageCid });
        expect(page.comments).toEqual([]);
        expect(getCommunityPage).toHaveBeenCalledTimes(1);
        expect(hotRpcClient.state).toBe("stopped");
    });
});

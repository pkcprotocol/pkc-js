import { afterEach, describe, expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import signers from "../../fixtures/signers.js";
import { mockPKCV2 } from "../../../dist/node/test/test-util.js";
import { PostsPages } from "../../../dist/node/pages/pages.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { PageIpfs } from "../../../dist/node/pages/types.js";

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

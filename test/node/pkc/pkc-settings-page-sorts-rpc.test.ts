import { describe, it, beforeAll, afterAll, expect } from "vitest";
import path from "path";
import net from "node:net";
import PKC from "../../../dist/node/index.js";
import PKCWsServer from "../../../dist/node/rpc/src/index.js";
import { mockRpcServerPKC, mockRpcServerForTests, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { PageSortFileFactory } from "../../../dist/node/community/types.js";

type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

// A custom page sort registered on the server only: newest first, but keyed under its own sortName.
const customNewestFirst: PageSortFileFactory = () => ({
    sortName: "custom-newest",
    description: "Newest first, registered through pkc.settings.pageSorts on the server",
    optionInputs: [],
    scoreAll: ({ comments }) => new Map(comments.map((entry) => [entry.commentUpdate.cid, entry.comment.timestamp]))
});

const RPC_AUTH_KEY = "test-settings-page-sorts";

const getAvailablePort = async (startPort = 39760): Promise<number> => {
    for (let port = startPort; port < startPort + 100; port++) {
        try {
            return await new Promise<number>((resolve, reject) => {
                const server = net.createServer();
                server.unref();
                server.on("error", reject);
                server.listen(port, () => {
                    server.close(() => resolve(port));
                });
            });
        } catch {
            continue;
        }
    }
    throw new Error(`No available port found in range ${startPort}-${startPort + 99}`);
};

// The owner-facing configuration UI talks to the community over RPC, so the page sort registry and the
// validation failures have to survive serialization, same as settings.challenges (issue #73).
describe("pkc.settings.pageSorts over RPC", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let RPC_URL: string;

    beforeAll(async () => {
        serverPKC = await mockRpcServerPKC({ dataPath: path.join(process.cwd(), ".pkc-rpc-settings-page-sorts-test") });
        serverPKC.settings.pageSorts = { "custom-newest": customNewestFirst };

        const rpcPort = await getAvailablePort();
        RPC_URL = `ws://localhost:${rpcPort}`;
        rpcServer = await PKCWsServer.PKCWsServer({
            port: rpcPort,
            authKey: RPC_AUTH_KEY,
            pkcOptions: { kuboRpcClientsOptions: ["http://localhost:15001/api/v0"], httpRoutersOptions: [], dataPath: serverPKC.dataPath }
        });
        const server = rpcServer as unknown as {
            _initPKC: (pkc: PKCType) => void;
            _createPKCInstanceFromSetSettings: (newOptions: Record<string, unknown>) => Promise<PKCType>;
        };
        server._initPKC(serverPKC);
        server._createPKCInstanceFromSetSettings = async (newOptions) => {
            const newPKC = await mockRpcServerPKC({
                dataPath: path.join(process.cwd(), ".pkc-rpc-settings-page-sorts-test"),
                ...newOptions
            });
            newPKC.settings.pageSorts = serverPKC.settings.pageSorts;
            return newPKC;
        };
        mockRpcServerForTests(rpcServer);
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
    });

    const connectClient = async () => {
        const clientPKC = await PKC({ pkcRpcClientsOptions: [RPC_URL], dataPath: undefined, httpRoutersOptions: [] });
        clientPKC.on("error", () => {}); // Prevent uncaught errors from WebSocket reconnection
        const rpcClient = clientPKC.clients.pkcRpcClients[RPC_URL];
        await resolveWhenConditionIsTrue({
            toUpdate: rpcClient,
            predicate: async () => Boolean(rpcClient.settings?.pageSorts),
            eventName: "settingschange"
        });
        return { clientPKC, settings: rpcClient.settings! };
    };

    it("RPC client receives the built-in and custom page sorts, minus their functions", async () => {
        const { clientPKC, settings } = await connectClient();
        expect(settings.pageSorts).to.be.an("object");
        for (const builtIn of ["hot", "new", "old", "best", "top", "topWeek", "active", "controversial", "newFlat", "oldFlat"])
            expect(settings.pageSorts![builtIn].sortName, builtIn).to.equal(builtIn);
        expect(settings.pageSorts!.active.scope).to.equal("posts");
        expect(settings.pageSorts!.newFlat.flat).to.be.true;
        expect(settings.pageSorts!.topWeek.defaultOptions).to.deep.equal({ maxAge: "1w" });
        expect(settings.pageSorts!["custom-newest"].description).to.include("registered through pkc.settings.pageSorts");
        expect(settings.pageSorts!["custom-newest"]).to.not.have.property("scoreAll");
        await clientPKC.destroy();
    });

    it("an RpcLocalCommunity rejects a name the server does not have before the round trip, and accepts a registered one", async () => {
        const { clientPKC } = await connectClient();
        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        try {
            let thrown: unknown;
            try {
                await community.edit({ settings: { ...community.settings, pages: { posts: [{ name: "not-on-server" }] } } });
            } catch (e) {
                thrown = e;
            }
            expect((thrown as PKCError)?.code).to.equal("ERR_RPC_CLIENT_PAGE_SORT_NAME_NOT_AVAILABLE_ON_SERVER");
            expect((thrown as PKCError).details.availablePageSorts).to.include("custom-newest");

            const pages = {
                posts: [{ name: "custom-newest", preloaded: true }, { name: "hot" }],
                replies: [{ name: "old", preloaded: true }]
            };
            await community.edit({ settings: { ...community.settings, pages } });
            expect(community.settings?.pages).to.deep.equal(pages);
            expect(community.pageSorts).to.deep.equal({
                posts: {
                    "custom-newest": {
                        name: "custom-newest",
                        description: "Newest first, registered through pkc.settings.pageSorts on the server"
                    },
                    hot: { name: "hot", description: "Reddit-style hot ranking: votes weighted by age" }
                },
                replies: { old: { name: "old", description: "Oldest first" } }
            });
        } finally {
            await community.delete();
            await clientPKC.destroy();
        }
    });

    it("the aggregated edit failure arrives intact on an RpcLocalCommunity", async () => {
        const { clientPKC } = await connectClient();
        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        try {
            let thrown: unknown;
            try {
                await community.edit({
                    settings: {
                        ...community.settings,
                        pages: {
                            posts: [
                                { name: "hot", preloaded: true }, // valid
                                { name: "new", options: { maxAge: "soon" } }, // unparseable reserved option
                                { name: "newFlat" } // reply-only sort under posts
                            ]
                        }
                    }
                });
            } catch (e) {
                thrown = e;
            }
            expect(thrown, "edit() over RPC should have thrown").to.exist;
            expect((thrown as PKCError).code).to.equal("ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED_FOR_PAGE_SORTS");
            const failures = (thrown as PKCError).details.failures as {
                scope: string;
                pageSortIndex: number;
                pageSortName: string;
                error: PKCError;
            }[];
            expect(failures.map((f) => [f.scope, f.pageSortIndex, f.pageSortName, f.error.code])).to.deep.equal([
                ["posts", 1, "new", "ERR_PAGE_SORT_INVALID_RESERVED_OPTION"],
                ["posts", 2, "newFlat", "ERR_PAGE_SORT_SCOPE_MISMATCH"]
            ]);
            expect(failures[0].error.details.option).to.equal("maxAge");
            expect(community.settings?.pages).to.be.undefined; // nothing persisted
        } finally {
            await community.delete();
            await clientPKC.destroy();
        }
    });
});

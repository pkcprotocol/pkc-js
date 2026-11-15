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
    score: ({ comment }) => comment.timestamp
});

// A reply-dependent sort: the listing must carry `requireReplies` (a config UI shows what a sort costs) and drop the
// function, like every other file field.
const mostReplies: PageSortFileFactory = () => ({
    sortName: "most-replies",
    description: "Largest reply subtree first",
    optionInputs: [],
    requireReplies: true,
    score: ({ comment, replies }) => (replies?.length ?? 0) * 1e10 + comment.timestamp
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
        serverPKC.settings.pageSorts = { "custom-newest": customNewestFirst, "most-replies": mostReplies };

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
        expect(settings.pageSorts!["custom-newest"]).to.not.have.property("score");
        expect(settings.pageSorts!["most-replies"].requireReplies, "the listing says which sorts need the reply set").to.be.true;
        expect(settings.pageSorts!["most-replies"]).to.not.have.property("score");
        await clientPKC.destroy();
    });

    // A host that installs a sort package into the running server's registry (bitsocial-cli's `page-sort install`,
    // issue #411) calls notifySettingsChange so connected clients see it without reconnecting. It must not run the
    // other settings-change handlers, which restart every started community on the new pkc.
    it("notifySettingsChange pushes a newly registered page sort to a connected client and nothing else", async () => {
        const { clientPKC } = await connectClient();
        const rpcClient = clientPKC.clients.pkcRpcClients[RPC_URL];
        const server = rpcServer as unknown as {
            _onSettingsChange: Record<string, Record<number, (args: { newPKC: PKCType }) => Promise<void>>>;
        };
        let restartHandlerCalls = 0;
        server._onSettingsChange["fake-connection"] = { 1: async () => void restartHandlerCalls++ };
        const registry = serverPKC.settings.pageSorts!;
        registry["late-sort"] = (() => ({
            sortName: "late-sort",
            description: "Registered after the client connected",
            score: ({ comment }: { comment: { timestamp: number } }) => comment.timestamp
        })) as unknown as PageSortFileFactory;
        try {
            expect(rpcClient.settings?.pageSorts?.["late-sort"]).to.be.undefined;
            await rpcServer.notifySettingsChange();
            await resolveWhenConditionIsTrue({
                toUpdate: rpcClient,
                predicate: async () => Boolean(rpcClient.settings?.pageSorts?.["late-sort"]),
                eventName: "settingschange"
            });
            expect(rpcClient.settings!.pageSorts!["late-sort"].description).to.equal("Registered after the client connected");
            expect(restartHandlerCalls).to.equal(0);
        } finally {
            delete registry["late-sort"];
            delete server._onSettingsChange["fake-connection"];
            await clientPKC.destroy();
        }
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
            // publicOptions carries the full merged option set (the scope's reserved defaults here, nothing else was set)
            const exclusions = (removedDeletedApproved: "true" | "false") => ({
                pinnedFirst: "true",
                excludeRemovedComments: removedDeletedApproved,
                excludeDeletedComments: removedDeletedApproved,
                excludeCommentPendingApproval: "true",
                excludeCommentWithApprovedFalse: removedDeletedApproved
            });
            expect(community.pageSorts).to.deep.equal({
                posts: {
                    "custom-newest": {
                        name: "custom-newest",
                        description: "Newest first, registered through pkc.settings.pageSorts on the server",
                        publicOptions: exclusions("true")
                    },
                    hot: { name: "hot", description: "Reddit-style hot ranking: votes weighted by age", publicOptions: exclusions("true") }
                },
                replies: { old: { name: "old", description: "Oldest first", publicOptions: exclusions("false") } }
            });
        } finally {
            await community.delete();
            await clientPKC.destroy();
        }
    });

    // Issue #483: the owner-facing UI sets the wire key of an entry over RPC
    it("a sortName override round-trips over RPC and keys community.pageSorts", async () => {
        const { clientPKC } = await connectClient();
        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        try {
            const pages = {
                posts: [
                    { name: "top", sortName: "topFortnight", options: { maxAge: "2w" }, preloaded: true },
                    { name: "top", sortName: "topYearly", options: { maxAge: "1y" } },
                    { name: "custom-newest", sortName: "latest" }
                ],
                replies: [{ name: "old", sortName: "chronological", preloaded: true }]
            };
            await community.edit({ settings: { ...community.settings, pages } });
            expect(community.settings?.pages).to.deep.equal(pages);
            expect(Object.keys(community.pageSorts?.posts ?? {})).to.deep.equal(["topFortnight", "topYearly", "latest"]);
            expect(community.pageSorts?.posts?.topFortnight).to.include({ name: "top" });
            expect(community.pageSorts?.posts?.topFortnight?.publicOptions?.maxAge).to.equal("2w");
            expect(community.pageSorts?.posts?.topYearly?.publicOptions?.maxAge).to.equal("1y");
            expect(community.pageSorts?.posts?.latest).to.include({
                name: "custom-newest",
                description: "Newest first, registered through pkc.settings.pageSorts on the server"
            });
            expect(Object.keys(community.pageSorts?.replies ?? {})).to.deep.equal(["chronological"]);
            expect(community.pageSorts?.replies?.chronological?.name).to.equal("old");

            // a fresh instance of the same community reads the stored settings back from the server
            const reloaded = (await clientPKC.createCommunity({ address: community.address })) as RpcLocalCommunity;
            expect(reloaded.settings?.pages).to.deep.equal(pages);
        } finally {
            await community.delete();
            await clientPKC.destroy();
        }
    });

    it("a duplicate between a sortName override and another entry's key is rejected over RPC with the resolved key", async () => {
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
                                { name: "hot", preloaded: true },
                                { name: "custom-newest", sortName: "hot" }, // collides with the built-in's own key
                                { name: "new", sortName: "latest" },
                                { name: "old", sortName: "latest" } // collides with the override above
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
            expect(failures.map((f) => [f.scope, f.pageSortIndex, f.pageSortName, f.error.code, f.error.details.sortName])).to.deep.equal([
                ["posts", 1, "custom-newest", "ERR_PAGE_SORT_DUPLICATE_SORT_NAME", "hot"],
                ["posts", 3, "old", "ERR_PAGE_SORT_DUPLICATE_SORT_NAME", "latest"]
            ]);
            expect(community.settings?.pages).to.be.undefined; // nothing persisted
        } finally {
            await community.delete();
            await clientPKC.destroy();
        }
    });

    it("a reserved object key as a sortName override is rejected over RPC and nothing is persisted", async () => {
        const { clientPKC } = await connectClient();
        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        try {
            for (const reserved of ["__proto__", "constructor", "prototype", "toString"]) {
                let thrown: unknown;
                try {
                    await community.edit({ settings: { ...community.settings, pages: { posts: [{ name: "hot", sortName: reserved }] } } });
                } catch (e) {
                    thrown = e;
                }
                // the RPC client parses the edit params before sending them, so this is its zod error, not a server reply
                const issues = (thrown as { issues?: { path: (string | number)[]; message: string }[] } | undefined)?.issues;
                expect(issues, `${reserved} should have been rejected`).to.have.length(1);
                expect(issues![0].path.slice(-4), reserved).to.deep.equal(["pages", "posts", 0, "sortName"]);
                expect(issues![0].message).to.include("__proto__, constructor or prototype");
            }
            expect(community.settings?.pages).to.be.undefined;
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

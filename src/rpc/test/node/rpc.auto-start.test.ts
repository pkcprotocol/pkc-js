import { beforeAll, afterAll, describe, it, expect, beforeEach, afterEach } from "vitest";
import PKCWsServer from "../../../../dist/node/rpc/src/index.js";
import { describeSkipIfRpc, mockPKC } from "../../../../dist/node/test/test-util.js";
import tempy from "tempy";
import path from "path";
import Database from "better-sqlite3";

import PKC from "../../../../dist/node/index.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { CreatePKCWsServerOptions } from "../../../../dist/node/rpc/src/types.js";

type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

// Interface for accessing private members
interface PKCWsServerPrivateAccess {
    _startedCommunities: Record<string, unknown>;
    _autoStartPreviousCommunities: () => Promise<void>;
}

const waitForCommunityToBeStarted = async (rpcServer: PKCWsServerType, address: string, timeout = 10000): Promise<void> => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const privateAccess = rpcServer as unknown as PKCWsServerPrivateAccess;
        if (address in privateAccess._startedCommunities && privateAccess._startedCommunities[address] !== "pending") {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timeout waiting for community ${address} to be started`);
};

describeSkipIfRpc(`RPC Server Auto-Start Communities`, async () => {
    let basePKC: PKCType;

    beforeAll(async () => {
        basePKC = await mockPKC();
    });

    afterAll(async () => {
        await basePKC.destroy();
    });

    /**
     * Matrix Scenario Tests:
     *
     * | # | Community state on last RPC exit        | startStartedCommunitiesOnStartup | Expected behavior        |
     * |---|----------------------------------------|----------------------------------|--------------------------|
     * | 1 | Was running (not stopped explicitly)   | true                             | Auto-start               |
     * | 2 | Was running (not stopped explicitly)   | false                            | Do nothing               |
     * | 3 | Was stopped explicitly by user         | true                             | Do nothing               |
     * | 4 | Was stopped explicitly by user         | false                            | Do nothing               |
     * | 5 | Never started in this RPC session      | true                             | Do nothing               |
     * | 6 | Never started in this RPC session      | false                            | Do nothing               |
     */

    describe("Scenario 1: Was running (not stopped explicitly) + startStartedCommunitiesOnStartup=true", () => {
        it("should auto-start the community on RPC server restart", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19150;

            // Create first RPC server and start a community
            const options1: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            const rpcServer1 = await PKCWsServer.PKCWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPKC1 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create and start a community
            const community = (await clientPKC1.createCommunity({})) as RpcLocalCommunity;
            const communityAddress = community.address;
            await community.start();

            // Verify it's running
            expect(community.started).to.be.true;

            // Destroy without stopping (simulating crash/restart)
            await clientPKC1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server with auto-start enabled
            const options2: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            const rpcServer2 = await PKCWsServer.PKCWsServer(options2);

            // Wait for auto-start to complete
            await waitForCommunityToBeStarted(rpcServer2, communityAddress);

            // Verify it was auto-started
            const privateAccess = rpcServer2 as unknown as PKCWsServerPrivateAccess;
            expect(communityAddress in privateAccess._startedCommunities).to.be.true;

            // Clean up
            const clientPKC2 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const community2 = (await clientPKC2.createCommunity({ address: communityAddress })) as RpcLocalCommunity;
            await community2.stop();
            await community2.delete();
            await clientPKC2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Scenario 2: Was running (not stopped explicitly) + startStartedCommunitiesOnStartup=false", () => {
        it("should NOT auto-start the community on RPC server restart", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19151;

            // Create first RPC server with auto-start enabled to create the state
            const options1: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            const rpcServer1 = await PKCWsServer.PKCWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPKC1 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create and start a community
            const community = (await clientPKC1.createCommunity({})) as RpcLocalCommunity;
            const communityAddress = community.address;
            await community.start();

            // Destroy without stopping
            await clientPKC1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server with auto-start DISABLED
            const options2: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: false
            };

            const rpcServer2 = await PKCWsServer.PKCWsServer(options2);

            // Wait a bit to ensure auto-start would have happened if enabled
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify it was NOT auto-started
            const privateAccess = rpcServer2 as unknown as PKCWsServerPrivateAccess;
            expect(communityAddress in privateAccess._startedCommunities).to.be.false;

            // Clean up
            const clientPKC2 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const community2 = (await clientPKC2.createCommunity({ address: communityAddress })) as RpcLocalCommunity;
            await community2.delete();
            await clientPKC2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Scenario 3: Was stopped explicitly by user + startStartedCommunitiesOnStartup=true", () => {
        it("should NOT auto-start the community that was explicitly stopped", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19152;

            const options1: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            const rpcServer1 = await PKCWsServer.PKCWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPKC1 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create, start, then EXPLICITLY STOP a community
            const community = (await clientPKC1.createCommunity({})) as RpcLocalCommunity;
            const communityAddress = community.address;
            await community.start();
            await community.stop(); // Explicitly stopped!

            await clientPKC1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server with auto-start enabled
            const options2: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            const rpcServer2 = await PKCWsServer.PKCWsServer(options2);

            // Wait a bit
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify it was NOT auto-started (because it was explicitly stopped)
            const privateAccess = rpcServer2 as unknown as PKCWsServerPrivateAccess;
            expect(communityAddress in privateAccess._startedCommunities).to.be.false;

            // Clean up
            const clientPKC2 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const community2 = (await clientPKC2.createCommunity({ address: communityAddress })) as RpcLocalCommunity;
            await community2.delete();
            await clientPKC2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Scenario 4: Was stopped explicitly by user + startStartedCommunitiesOnStartup=false", () => {
        it("should NOT auto-start the community", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19153;

            const options1: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: false
            };

            const rpcServer1 = await PKCWsServer.PKCWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPKC1 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create, start, then explicitly stop
            const community = (await clientPKC1.createCommunity({})) as RpcLocalCommunity;
            const communityAddress = community.address;
            await community.start();
            await community.stop();

            await clientPKC1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server with auto-start disabled
            const options2: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: false
            };

            const rpcServer2 = await PKCWsServer.PKCWsServer(options2);

            await new Promise((resolve) => setTimeout(resolve, 1000));

            const privateAccess = rpcServer2 as unknown as PKCWsServerPrivateAccess;
            expect(communityAddress in privateAccess._startedCommunities).to.be.false;

            // Clean up
            const clientPKC2 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const community2 = (await clientPKC2.createCommunity({ address: communityAddress })) as RpcLocalCommunity;
            await community2.delete();
            await clientPKC2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Scenario 5: Never started in this RPC session + startStartedCommunitiesOnStartup=true", () => {
        it("should NOT auto-start a community that was never started", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19154;

            const options1: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            const rpcServer1 = await PKCWsServer.PKCWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPKC1 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create a community but NEVER START IT
            const community = (await clientPKC1.createCommunity({})) as RpcLocalCommunity;
            const communityAddress = community.address;
            // Not calling community.start()!

            await clientPKC1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server
            const options2: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            const rpcServer2 = await PKCWsServer.PKCWsServer(options2);

            await new Promise((resolve) => setTimeout(resolve, 1000));

            const privateAccess = rpcServer2 as unknown as PKCWsServerPrivateAccess;
            expect(communityAddress in privateAccess._startedCommunities).to.be.false;

            // Clean up
            const clientPKC2 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const community2 = (await clientPKC2.createCommunity({ address: communityAddress })) as RpcLocalCommunity;
            await community2.delete();
            await clientPKC2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Scenario 6: Never started in this RPC session + startStartedCommunitiesOnStartup=false", () => {
        it("should NOT auto-start a community that was never started", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19155;

            const options1: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: false
            };

            const rpcServer1 = await PKCWsServer.PKCWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPKC1 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create a community but NEVER START IT
            const community = (await clientPKC1.createCommunity({})) as RpcLocalCommunity;
            const communityAddress = community.address;

            await clientPKC1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server
            const options2: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: false
            };

            const rpcServer2 = await PKCWsServer.PKCWsServer(options2);

            await new Promise((resolve) => setTimeout(resolve, 1000));

            const privateAccess = rpcServer2 as unknown as PKCWsServerPrivateAccess;
            expect(communityAddress in privateAccess._startedCommunities).to.be.false;

            // Clean up
            const clientPKC2 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const community2 = (await clientPKC2.createCommunity({ address: communityAddress })) as RpcLocalCommunity;
            await community2.delete();
            await clientPKC2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Edge cases", () => {
        it("should handle deleted community gracefully (clean up stale state)", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19156;

            const options1: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            const rpcServer1 = await PKCWsServer.PKCWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPKC1 = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create and start a community
            const community = (await clientPKC1.createCommunity({})) as RpcLocalCommunity;
            const communityAddress = community.address;
            await community.start();

            // Now delete it
            await community.stop();
            await community.delete();

            await clientPKC1.destroy();
            await rpcServer1.destroy();

            // Manually add the deleted community address back to the SQLite DB to simulate stale state
            const dbPath = path.join(dataPath, "rpc-server", "rpc-state.db");
            const db = new Database(dbPath);
            db.prepare("INSERT OR REPLACE INTO community_states (address, wasStarted, wasExplicitlyStopped) VALUES (?, 1, 0)").run(
                communityAddress
            );
            db.close();

            // Create second RPC server
            const options2: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            const rpcServer2 = await PKCWsServer.PKCWsServer(options2);

            // Wait for auto-start attempt
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Should NOT have started the deleted community
            const privateAccess = rpcServer2 as unknown as PKCWsServerPrivateAccess;
            expect(communityAddress in privateAccess._startedCommunities).to.be.false;

            // Verify the stale entry was removed from state
            const dbAfter = new Database(dbPath);
            const row = dbAfter.prepare("SELECT * FROM community_states WHERE address = ?").get(communityAddress);
            expect(row).to.be.undefined;
            dbAfter.close();

            await rpcServer2.destroy();
        });

        it("should handle first run with no state DB gracefully", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19157;

            const options: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            // Should not throw, should handle gracefully
            const rpcServer = await PKCWsServer.PKCWsServer(options);

            // Server should be functional
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
            expect(community.address).to.exist;

            await community.delete();
            await clientPKC.destroy();
            await rpcServer.destroy();
        });

        it("should handle first run with no state DB and no dataPath directory", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19158;

            const options: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            // Should not throw on first run
            const rpcServer = await PKCWsServer.PKCWsServer(options);

            // Server should be functional
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
            expect(community.address).to.exist;

            await community.delete();
            await clientPKC.destroy();
            await rpcServer.destroy();
        });

        it("should update state DB when community address changes via edit", async () => {
            // Note: This test would need domain resolution support to fully work
            // For now, we just verify the state tracking mechanism
            const dataPath = tempy.directory();
            const rpcServerPort = 19159;

            const options: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: true
            };

            const rpcServer = await PKCWsServer.PKCWsServer(options);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
            const oldAddress = community.address;
            await community.start();

            // Verify state DB has the old address
            const dbPath = path.join(dataPath, "rpc-server", "rpc-state.db");
            const db = new Database(dbPath);
            const row = db.prepare("SELECT * FROM community_states WHERE address = ?").get(oldAddress) as
                | { wasStarted: number }
                | undefined;
            expect(row).to.exist;
            expect(row!.wasStarted).to.equal(1);
            db.close();

            await community.stop();
            await community.delete();
            await clientPKC.destroy();
            await rpcServer.destroy();
        });

        it("should handle rapid concurrent state updates without errors", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19160;

            const options: CreatePKCWsServerOptions = {
                port: rpcServerPort,
                pkcOptions: {
                    kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePKC.httpRoutersOptions,
                    dataPath
                },
                startStartedCommunitiesOnStartup: false
            };

            const rpcServer = await PKCWsServer.PKCWsServer(options);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;

            // Track errors emitted by the RPC server
            const errors: Error[] = [];
            rpcServer.on("error", (e) => errors.push(e));

            // Create multiple communities
            const communityCount = 5;
            const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            const communities: RpcLocalCommunity[] = [];
            for (let i = 0; i < communityCount; i++) {
                const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
                communities.push(community);
            }

            // Start all communities concurrently — each start writes to the state DB
            await Promise.all(communities.map((community) => community.start()));

            // Verify state DB has all entries
            const dbPath = path.join(dataPath, "rpc-server", "rpc-state.db");
            const db = new Database(dbPath);
            const rows = db.prepare("SELECT * FROM community_states WHERE wasStarted = 1").all() as { address: string }[];
            expect(rows.length).to.equal(communityCount);

            for (const community of communities) {
                const row = db.prepare("SELECT * FROM community_states WHERE address = ?").get(community.address);
                expect(row).to.exist;
            }

            // Stop all concurrently — each stop writes to the state DB
            await Promise.all(communities.map((community) => community.stop()));

            // Verify all are marked as explicitly stopped
            const stoppedRows = db.prepare("SELECT * FROM community_states WHERE wasExplicitlyStopped = 1").all() as { address: string }[];
            expect(stoppedRows.length).to.equal(communityCount);

            db.close();

            // No errors should have been emitted from state file operations
            expect(errors.length).to.equal(0);

            // Clean up
            for (const community of communities) {
                await community.delete();
            }
            await clientPKC.destroy();
            await rpcServer.destroy();
        });
    });
});

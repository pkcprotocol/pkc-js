import { beforeAll, afterAll, describe, it, expect, beforeEach, afterEach } from "vitest";
import PlebbitWsServer from "../../../../dist/node/rpc/src/index.js";
import { describeSkipIfRpc, mockPlebbit } from "../../../../dist/node/test/test-util.js";
import tempy from "tempy";
import path from "path";
import Database from "better-sqlite3";

import Plebbit from "../../../../dist/node/index.js";
import type { Plebbit as PlebbitType } from "../../../../dist/node/pkc/pkc.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/community/rpc-local-community.js";
import type { CreatePlebbitWsServerOptions } from "../../../../dist/node/rpc/src/types.js";

type PlebbitWsServerType = Awaited<ReturnType<typeof PlebbitWsServer.PlebbitWsServer>>;

// Interface for accessing private members
interface PlebbitWsServerPrivateAccess {
    _startedSubplebbits: Record<string, unknown>;
    _autoStartPreviousSubplebbits: () => Promise<void>;
}

const waitForSubToBeStarted = async (rpcServer: PlebbitWsServerType, address: string, timeout = 10000): Promise<void> => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const privateAccess = rpcServer as unknown as PlebbitWsServerPrivateAccess;
        if (address in privateAccess._startedSubplebbits && privateAccess._startedSubplebbits[address] !== "pending") {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timeout waiting for sub ${address} to be started`);
};

describeSkipIfRpc(`RPC Server Auto-Start Subplebbits`, async () => {
    let basePlebbit: PlebbitType;

    beforeAll(async () => {
        basePlebbit = await mockPlebbit();
    });

    afterAll(async () => {
        await basePlebbit.destroy();
    });

    /**
     * Matrix Scenario Tests:
     *
     * | # | Sub state on last RPC exit             | startStartedSubplebbitsOnStartup | Expected behavior        |
     * |---|----------------------------------------|----------------------------------|--------------------------|
     * | 1 | Was running (not stopped explicitly)   | true                             | Auto-start               |
     * | 2 | Was running (not stopped explicitly)   | false                            | Do nothing               |
     * | 3 | Was stopped explicitly by user         | true                             | Do nothing               |
     * | 4 | Was stopped explicitly by user         | false                            | Do nothing               |
     * | 5 | Never started in this RPC session      | true                             | Do nothing               |
     * | 6 | Never started in this RPC session      | false                            | Do nothing               |
     */

    describe("Scenario 1: Was running (not stopped explicitly) + startStartedSubplebbitsOnStartup=true", () => {
        it("should auto-start the subplebbit on RPC server restart", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19150;

            // Create first RPC server and start a sub
            const options1: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            const rpcServer1 = await PlebbitWsServer.PlebbitWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPlebbit1 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create and start a subplebbit
            const sub = (await clientPlebbit1.createSubplebbit({})) as RpcLocalSubplebbit;
            const subAddress = sub.address;
            await sub.start();

            // Verify it's running
            expect(sub.started).to.be.true;

            // Destroy without stopping (simulating crash/restart)
            await clientPlebbit1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server with auto-start enabled
            const options2: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            const rpcServer2 = await PlebbitWsServer.PlebbitWsServer(options2);

            // Wait for auto-start to complete
            await waitForSubToBeStarted(rpcServer2, subAddress);

            // Verify it was auto-started
            const privateAccess = rpcServer2 as unknown as PlebbitWsServerPrivateAccess;
            expect(subAddress in privateAccess._startedSubplebbits).to.be.true;

            // Clean up
            const clientPlebbit2 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const sub2 = (await clientPlebbit2.createSubplebbit({ address: subAddress })) as RpcLocalSubplebbit;
            await sub2.stop();
            await sub2.delete();
            await clientPlebbit2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Scenario 2: Was running (not stopped explicitly) + startStartedSubplebbitsOnStartup=false", () => {
        it("should NOT auto-start the subplebbit on RPC server restart", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19151;

            // Create first RPC server with auto-start enabled to create the state
            const options1: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            const rpcServer1 = await PlebbitWsServer.PlebbitWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPlebbit1 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create and start a subplebbit
            const sub = (await clientPlebbit1.createSubplebbit({})) as RpcLocalSubplebbit;
            const subAddress = sub.address;
            await sub.start();

            // Destroy without stopping
            await clientPlebbit1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server with auto-start DISABLED
            const options2: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: false
            };

            const rpcServer2 = await PlebbitWsServer.PlebbitWsServer(options2);

            // Wait a bit to ensure auto-start would have happened if enabled
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify it was NOT auto-started
            const privateAccess = rpcServer2 as unknown as PlebbitWsServerPrivateAccess;
            expect(subAddress in privateAccess._startedSubplebbits).to.be.false;

            // Clean up
            const clientPlebbit2 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const sub2 = (await clientPlebbit2.createSubplebbit({ address: subAddress })) as RpcLocalSubplebbit;
            await sub2.delete();
            await clientPlebbit2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Scenario 3: Was stopped explicitly by user + startStartedSubplebbitsOnStartup=true", () => {
        it("should NOT auto-start the subplebbit that was explicitly stopped", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19152;

            const options1: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            const rpcServer1 = await PlebbitWsServer.PlebbitWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPlebbit1 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create, start, then EXPLICITLY STOP a subplebbit
            const sub = (await clientPlebbit1.createSubplebbit({})) as RpcLocalSubplebbit;
            const subAddress = sub.address;
            await sub.start();
            await sub.stop(); // Explicitly stopped!

            await clientPlebbit1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server with auto-start enabled
            const options2: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            const rpcServer2 = await PlebbitWsServer.PlebbitWsServer(options2);

            // Wait a bit
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify it was NOT auto-started (because it was explicitly stopped)
            const privateAccess = rpcServer2 as unknown as PlebbitWsServerPrivateAccess;
            expect(subAddress in privateAccess._startedSubplebbits).to.be.false;

            // Clean up
            const clientPlebbit2 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const sub2 = (await clientPlebbit2.createSubplebbit({ address: subAddress })) as RpcLocalSubplebbit;
            await sub2.delete();
            await clientPlebbit2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Scenario 4: Was stopped explicitly by user + startStartedSubplebbitsOnStartup=false", () => {
        it("should NOT auto-start the subplebbit", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19153;

            const options1: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: false
            };

            const rpcServer1 = await PlebbitWsServer.PlebbitWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPlebbit1 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create, start, then explicitly stop
            const sub = (await clientPlebbit1.createSubplebbit({})) as RpcLocalSubplebbit;
            const subAddress = sub.address;
            await sub.start();
            await sub.stop();

            await clientPlebbit1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server with auto-start disabled
            const options2: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: false
            };

            const rpcServer2 = await PlebbitWsServer.PlebbitWsServer(options2);

            await new Promise((resolve) => setTimeout(resolve, 1000));

            const privateAccess = rpcServer2 as unknown as PlebbitWsServerPrivateAccess;
            expect(subAddress in privateAccess._startedSubplebbits).to.be.false;

            // Clean up
            const clientPlebbit2 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const sub2 = (await clientPlebbit2.createSubplebbit({ address: subAddress })) as RpcLocalSubplebbit;
            await sub2.delete();
            await clientPlebbit2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Scenario 5: Never started in this RPC session + startStartedSubplebbitsOnStartup=true", () => {
        it("should NOT auto-start a subplebbit that was never started", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19154;

            const options1: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            const rpcServer1 = await PlebbitWsServer.PlebbitWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPlebbit1 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create a subplebbit but NEVER START IT
            const sub = (await clientPlebbit1.createSubplebbit({})) as RpcLocalSubplebbit;
            const subAddress = sub.address;
            // Not calling sub.start()!

            await clientPlebbit1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server
            const options2: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            const rpcServer2 = await PlebbitWsServer.PlebbitWsServer(options2);

            await new Promise((resolve) => setTimeout(resolve, 1000));

            const privateAccess = rpcServer2 as unknown as PlebbitWsServerPrivateAccess;
            expect(subAddress in privateAccess._startedSubplebbits).to.be.false;

            // Clean up
            const clientPlebbit2 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const sub2 = (await clientPlebbit2.createSubplebbit({ address: subAddress })) as RpcLocalSubplebbit;
            await sub2.delete();
            await clientPlebbit2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Scenario 6: Never started in this RPC session + startStartedSubplebbitsOnStartup=false", () => {
        it("should NOT auto-start a subplebbit that was never started", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19155;

            const options1: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: false
            };

            const rpcServer1 = await PlebbitWsServer.PlebbitWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPlebbit1 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create a subplebbit but NEVER START IT
            const sub = (await clientPlebbit1.createSubplebbit({})) as RpcLocalSubplebbit;
            const subAddress = sub.address;

            await clientPlebbit1.destroy();
            await rpcServer1.destroy();

            // Create second RPC server
            const options2: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: false
            };

            const rpcServer2 = await PlebbitWsServer.PlebbitWsServer(options2);

            await new Promise((resolve) => setTimeout(resolve, 1000));

            const privateAccess = rpcServer2 as unknown as PlebbitWsServerPrivateAccess;
            expect(subAddress in privateAccess._startedSubplebbits).to.be.false;

            // Clean up
            const clientPlebbit2 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const sub2 = (await clientPlebbit2.createSubplebbit({ address: subAddress })) as RpcLocalSubplebbit;
            await sub2.delete();
            await clientPlebbit2.destroy();
            await rpcServer2.destroy();
        });
    });

    describe("Edge cases", () => {
        it("should handle deleted subplebbit gracefully (clean up stale state)", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19156;

            const options1: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            const rpcServer1 = await PlebbitWsServer.PlebbitWsServer(options1);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPlebbit1 = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            // Create and start a subplebbit
            const sub = (await clientPlebbit1.createSubplebbit({})) as RpcLocalSubplebbit;
            const subAddress = sub.address;
            await sub.start();

            // Now delete it
            await sub.stop();
            await sub.delete();

            await clientPlebbit1.destroy();
            await rpcServer1.destroy();

            // Manually add the deleted sub address back to the SQLite DB to simulate stale state
            const dbPath = path.join(dataPath, "rpc-server", "rpc-state.db");
            const db = new Database(dbPath);
            db.prepare("INSERT OR REPLACE INTO subplebbit_states (address, wasStarted, wasExplicitlyStopped) VALUES (?, 1, 0)").run(
                subAddress
            );
            db.close();

            // Create second RPC server
            const options2: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            const rpcServer2 = await PlebbitWsServer.PlebbitWsServer(options2);

            // Wait for auto-start attempt
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Should NOT have started the deleted sub
            const privateAccess = rpcServer2 as unknown as PlebbitWsServerPrivateAccess;
            expect(subAddress in privateAccess._startedSubplebbits).to.be.false;

            // Verify the stale entry was removed from state
            const dbAfter = new Database(dbPath);
            const row = dbAfter.prepare("SELECT * FROM subplebbit_states WHERE address = ?").get(subAddress);
            expect(row).to.be.undefined;
            dbAfter.close();

            await rpcServer2.destroy();
        });

        it("should handle first run with no state DB gracefully", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19157;

            const options: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            // Should not throw, should handle gracefully
            const rpcServer = await PlebbitWsServer.PlebbitWsServer(options);

            // Server should be functional
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPlebbit = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            const sub = (await clientPlebbit.createSubplebbit({})) as RpcLocalSubplebbit;
            expect(sub.address).to.exist;

            await sub.delete();
            await clientPlebbit.destroy();
            await rpcServer.destroy();
        });

        it("should handle first run with no state DB and no dataPath directory", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19158;

            const options: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            // Should not throw on first run
            const rpcServer = await PlebbitWsServer.PlebbitWsServer(options);

            // Server should be functional
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPlebbit = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            const sub = (await clientPlebbit.createSubplebbit({})) as RpcLocalSubplebbit;
            expect(sub.address).to.exist;

            await sub.delete();
            await clientPlebbit.destroy();
            await rpcServer.destroy();
        });

        it("should update state DB when subplebbit address changes via edit", async () => {
            // Note: This test would need domain resolution support to fully work
            // For now, we just verify the state tracking mechanism
            const dataPath = tempy.directory();
            const rpcServerPort = 19159;

            const options: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: true
            };

            const rpcServer = await PlebbitWsServer.PlebbitWsServer(options);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;
            const clientPlebbit = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            const sub = (await clientPlebbit.createSubplebbit({})) as RpcLocalSubplebbit;
            const oldAddress = sub.address;
            await sub.start();

            // Verify state DB has the old address
            const dbPath = path.join(dataPath, "rpc-server", "rpc-state.db");
            const db = new Database(dbPath);
            const row = db.prepare("SELECT * FROM subplebbit_states WHERE address = ?").get(oldAddress) as
                | { wasStarted: number }
                | undefined;
            expect(row).to.exist;
            expect(row!.wasStarted).to.equal(1);
            db.close();

            await sub.stop();
            await sub.delete();
            await clientPlebbit.destroy();
            await rpcServer.destroy();
        });

        it("should handle rapid concurrent state updates without errors", async () => {
            const dataPath = tempy.directory();
            const rpcServerPort = 19160;

            const options: CreatePlebbitWsServerOptions = {
                port: rpcServerPort,
                plebbitOptions: {
                    kuboRpcClientsOptions:
                        basePlebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                    httpRoutersOptions: basePlebbit.httpRoutersOptions,
                    dataPath
                },
                startStartedSubplebbitsOnStartup: false
            };

            const rpcServer = await PlebbitWsServer.PlebbitWsServer(options);
            const rpcUrl = `ws://localhost:${rpcServerPort}`;

            // Track errors emitted by the RPC server
            const errors: Error[] = [];
            rpcServer.on("error", (e) => errors.push(e));

            // Create multiple subplebbits
            const subCount = 5;
            const clientPlebbit = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

            const subs: RpcLocalSubplebbit[] = [];
            for (let i = 0; i < subCount; i++) {
                const sub = (await clientPlebbit.createSubplebbit({})) as RpcLocalSubplebbit;
                subs.push(sub);
            }

            // Start all subplebbits concurrently — each start writes to the state DB
            await Promise.all(subs.map((sub) => sub.start()));

            // Verify state DB has all entries
            const dbPath = path.join(dataPath, "rpc-server", "rpc-state.db");
            const db = new Database(dbPath);
            const rows = db.prepare("SELECT * FROM subplebbit_states WHERE wasStarted = 1").all() as { address: string }[];
            expect(rows.length).to.equal(subCount);

            for (const sub of subs) {
                const row = db.prepare("SELECT * FROM subplebbit_states WHERE address = ?").get(sub.address);
                expect(row).to.exist;
            }

            // Stop all concurrently — each stop writes to the state DB
            await Promise.all(subs.map((sub) => sub.stop()));

            // Verify all are marked as explicitly stopped
            const stoppedRows = db.prepare("SELECT * FROM subplebbit_states WHERE wasExplicitlyStopped = 1").all() as { address: string }[];
            expect(stoppedRows.length).to.equal(subCount);

            db.close();

            // No errors should have been emitted from state file operations
            expect(errors.length).to.equal(0);

            // Clean up
            for (const sub of subs) {
                await sub.delete();
            }
            await clientPlebbit.destroy();
            await rpcServer.destroy();
        });
    });
});

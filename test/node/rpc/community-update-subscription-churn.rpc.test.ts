// Repro for issue #129: an RPC community-update subscription goes permanently silent when
// concurrent clients churn the shared server-side pkc._updatingCommunities entry during key
// migration. Models the CI flake on PR #128 where the key-migration test in
// test/node-and-browser/community/update.community.test.ts timed out at 160s.
//
// CI scenario being modeled:
//   1. client A subscribes to a domain with a stale publicKey -> the server detects key migration,
//      sends the error + cleared update, and keeps trying to fetch the new key's record.
//   2. concurrently, sibling clients (the #119 regression test and the publickey-fallback tests in
//      CI) subscribe to the SAME domain with DIFFERENT stale publicKeys, and to the new key
//      directly, then stop/destroy while the shared updating entry is still empty (pre-record).
//      In CI a burst of setSettings calls (which stop()+update() every community subscription
//      server-side) was also in flight.
//   3. client A must still receive the post-migration record. In the CI failure it never did: the
//      server-side updating entry was stopped out from under A's subscription and there is no
//      recovery path (the client hangs forever with its websocket still connected).
//
// To make the race window deterministic, the migration target's IPNS initially holds a record
// that fails signature verification, so the server's updating entry cycles in waiting-retry for
// as long as the churn needs (the CI window before the record fetch succeeded); the valid record
// is published only after the churn. Because the PKCWsServer runs in-process, the test also
// asserts the server-side invariants directly after every churn round: the domain's updating
// entry must exist, still be updating, with its mirror listener count back at the baseline.
import { describe, beforeAll, afterAll, expect } from "vitest";
import path from "path";
import net from "node:net";
import PKC from "../../../dist/node/index.js";
import PKCWsServer from "../../../dist/node/rpc/src/index.js";
import {
    createMockedCommunityIpns,
    createMockNameResolver,
    createNewIpns,
    mockRpcServerForTests,
    mockRpcServerPKC,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { signCommunity } from "../../../dist/node/signer/signatures.js";
import { findUpdatingCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { InputPKCOptions } from "../../../dist/node/types.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { CommunityIpfsType } from "../../../dist/node/community/types.js";

type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

const RPC_AUTH_KEY = "test-community-subscription-churn";

const getAvailablePort = async (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close(() => reject(new Error("Failed to allocate a TCP port for the RPC test server")));
                return;
            }
            server.close(() => resolve(address.port));
        });
    });

const pollUntil = async (predicate: () => boolean, ms: number, label: string): Promise<void> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < ms) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out after ${ms}ms polling for: ${label}`);
};

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${label}`)), ms);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

describe("RPC community update subscription survives concurrent sibling churn (#129)", () => {
    // Mutable record map read by the mock resolver at resolve time; tests register domains here
    const resolverRecords = new Map<string, string | undefined>();

    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    const createClient = async (): Promise<PKCType> => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        client.on("error", () => {});
        return client;
    };

    // The ws-server's CURRENT pkc (setSettings swaps it for a new instance)
    const getServerPkc = (): PKCType => (rpcServer as unknown as { pkc: PKCType }).pkc;

    // The server-side updating entry for a domain; the subscription of client A mirrors this
    const getServerUpdatingEntry = (domain: string): RemoteCommunity | undefined =>
        findUpdatingCommunity(getServerPkc(), { name: domain }) as RemoteCommunity | undefined;

    // Creates a migration target whose IPNS initially points to a record that FAILS signature
    // verification (signed by a key that does not own the IPNS name), so the server's updating
    // entry cycles healthily in waiting-retry (fetch -> reject -> retry) without ever delivering
    // data: a deterministic, arbitrarily-long version of the CI pre-record window. Calling
    // publishRecord() ends the window by publishing a valid record
    const createMigrationTargetWithInvalidRecord = async () => {
        const newIpns = await createNewIpns();
        const { communityRecord: templateRecord, ipnsObj: templateIpns } = await createMockedCommunityIpns({});
        const makeRecord = async (signer: typeof newIpns.signer) => {
            const record = <CommunityIpfsType>{ ...templateRecord, posts: undefined, pubsubTopic: newIpns.signer.address };
            if (!record.posts) delete record.posts;
            record.signature = await signCommunity({ community: record, signer });
            return record;
        };
        // signed by the template's key, published under newIpns' name -> rejected by verification
        await newIpns.publishToIpns(JSON.stringify(await makeRecord(templateIpns.signer)));
        const publishRecord = async () => {
            await newIpns.publishToIpns(JSON.stringify(await makeRecord(newIpns.signer)));
        };
        return { newKey: newIpns.signer.address, publishRecord, destroy: () => newIpns.pkc.destroy() };
    };

    // Subscribes client A to the domain with a stale key and waits for the key migration signal
    // (error + cleared update). Returns the still-updating community
    const subscribeMigrationVictim = async (clientA: PKCType, domain: string, oldKey: string, newKey: string) => {
        const communityA = await clientA.createCommunity({ address: domain, publicKey: oldKey });
        const errorPromise = new Promise<PKCError>((resolve) => {
            communityA.on("error", (err) => {
                if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") resolve(err as PKCError);
            });
        });
        const clearedUpdatePromise = new Promise<void>((resolve) => {
            communityA.on("update", () => {
                if (communityA.publicKey === newKey && communityA.updatedAt === undefined) resolve();
            });
        });
        await communityA.update();
        await withTimeout(errorPromise, 30_000, "client A key-migration error");
        await withTimeout(clearedUpdatePromise, 30_000, "client A cleared update after key migration");
        expect(communityA.publicKey).to.equal(newKey);
        expect(communityA.address).to.equal(domain);
        return communityA;
    };

    beforeAll(async () => {
        dataPath = path.join(process.cwd(), `.pkc-rpc-subscription-churn-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
        serverPKC = await mockRpcServerPKC({
            dataPath,
            nameResolvers: [createMockNameResolver({ records: resolverRecords })]
        });

        const rpcPort = await getAvailablePort();
        rpcUrl = `ws://localhost:${rpcPort}`;

        rpcServer = await PKCWsServer.PKCWsServer({
            port: rpcPort,
            authKey: RPC_AUTH_KEY,
            pkcOptions: {
                kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                httpRoutersOptions: [],
                dataPath: serverPKC.dataPath
            }
        });

        const server = rpcServer as unknown as Record<string, Function>;
        server._initPKC(serverPKC);
        // Same shape as test/server/pkc-ws-server.js: newOptions already carries the previous pkc's
        // nameResolvers (the server preserves them in setSettings), so resolver keys stay stable
        server._createPKCInstanceFromSetSettings = async (newOptions: InputPKCOptions) =>
            mockRpcServerPKC({
                dataPath,
                ...newOptions
            });
        mockRpcServerForTests(rpcServer);
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc(`subscription and its server-side updating entry survive sibling churn during the pre-record migration window`, async () => {
        const target = await createMigrationTargetWithInvalidRecord();
        const { communityAddress: oldKeyA } = await createMockedCommunityIpns({});
        const domain = `churn-migrating-${Date.now()}.bso`;
        resolverRecords.set(domain, target.newKey);

        const clientA = await createClient();
        try {
            const communityA = await subscribeMigrationVictim(clientA, domain, oldKeyA, target.newKey);

            // Snapshot the server-side updating entry that client A's subscription depends on.
            // setSettings legitimately re-creates entries on the new server pkc, so rounds compare
            // against the CURRENT entry rather than instance identity
            const initialEntry = getServerUpdatingEntry(domain);
            expect(initialEntry, "server should have an updating entry for the domain").to.exist;
            const baselineListeners = initialEntry!._numOfListenersForUpdatingInstance;
            expect(initialEntry!.state).to.equal("updating");

            // Churn rounds modeled on the tests that ran concurrently in CI: in every round two
            // sibling clients subscribe to the same domain (different stale keys) and to the new
            // key directly, then ALL teardowns run overlapped (stop + destroy + ws disconnect in
            // flight at once), like the concurrent vitest tests in the CI run. The record is still
            // undeliverable, so the entry is in the same pre-record window as the CI failure
            const CHURN_ROUNDS = 10;
            for (let round = 0; round < CHURN_ROUNDS; round++) {
                const [clientB, clientC] = await Promise.all([createClient(), createClient()]);
                const [staleKeyB, staleKeyC] = await Promise.all([
                    clientB.createSigner().then((s) => s.address),
                    clientC.createSigner().then((s) => s.address)
                ]);
                const communityB = await clientB.createCommunity({ address: domain, publicKey: staleKeyB });
                const communityC = await clientC.createCommunity({ address: domain, publicKey: staleKeyC });
                const keyCommunityB = await clientB.createCommunity({ address: target.newKey });
                await Promise.all([communityB.update(), communityC.update(), keyCommunityB.update()]);

                // The subscribe RPC resolves only after the server has mirrored the shared entry,
                // so the siblings must be attached by now
                const entryDuringRound = getServerUpdatingEntry(domain);
                expect(entryDuringRound, `updating entry must exist during churn round ${round}`).to.exist;
                expect(
                    entryDuringRound!._numOfListenersForUpdatingInstance,
                    `sibling subscriptions must attach to the shared updating entry (round ${round})`
                ).to.be.greaterThan(baselineListeners);

                // Overlapped teardown: explicit stops racing client destroys (ws disconnects), a
                // settings change (which stop()+update()s every community subscription server-side)
                // and a fresh victim binding to the domain mid-churn, so the server processes
                // unsubscribe cleanups, disconnect cleanups, _onSettingsChange handlers, new binds
                // and entry teardown cascades concurrently, like the CI storm
                const lateVictim = await clientA.createCommunity({ address: domain, publicKey: staleKeyB });
                const rpcClientA = clientA.clients.pkcRpcClients[rpcUrl];
                await Promise.all([
                    keyCommunityB.stop().then(() => communityB.stop()),
                    clientB.destroy(),
                    communityC.stop(),
                    clientC.destroy(),
                    lateVictim.update(),
                    rpcClientA.settings?.pkcOptions
                        ? rpcClientA.setSettings({
                              pkcOptions: {
                                  resolveAuthorNames: rpcClientA.settings.pkcOptions.resolveAuthorNames,
                                  validatePages: rpcClientA.settings.pkcOptions.validatePages,
                                  publishInterval: rpcClientA.settings.pkcOptions.publishInterval,
                                  updateInterval: rpcClientA.settings.pkcOptions.updateInterval,
                                  noData: rpcClientA.settings.pkcOptions.noData,
                                  httpRoutersOptions: rpcClientA.settings.pkcOptions.httpRoutersOptions,
                                  userAgent: `churn-round-${round}`
                              }
                          })
                        : Promise.resolve()
                ]);
                await lateVictim.stop();

                // Give the server a moment to finish async cleanups triggered by the teardown
                await new Promise((resolve) => setTimeout(resolve, 200));

                const entryAfterRound = getServerUpdatingEntry(domain);
                expect(entryAfterRound, `updating entry must still exist after churn round ${round}`).to.exist;
                expect(entryAfterRound!.state, `updating entry must still be updating after churn round ${round}`).to.equal("updating");
                expect(
                    entryAfterRound!._numOfListenersForUpdatingInstance,
                    `updating entry listener count must return to baseline after churn round ${round}`
                ).to.equal(baselineListeners);
            }

            // End the pre-record window: publish the post-migration record. Client A's subscription
            // must still be wired up end to end and deliver it
            await target.publishRecord();

            // Layer 1: the server-side updating entry must fetch the record. If this fails the
            // entry's update loop is dead even though its bookkeeping looks healthy
            const finalEntry = getServerUpdatingEntry(domain);
            expect(finalEntry, "updating entry must exist when the record is published").to.exist;
            await pollUntil(
                () => typeof finalEntry!.updatedAt === "number",
                60_000,
                `server-side updating entry to fetch the published record (entry state=${finalEntry!.state}, updatingState=${finalEntry!.updatingState}, listeners=${finalEntry!._numOfListenersForUpdatingInstance})`
            );
            // Layer 2: client A's subscription must still be attached to the entry
            expect(
                finalEntry!._numOfListenersForUpdatingInstance,
                "client A's server-side subscription must still mirror the updating entry"
            ).to.equal(baselineListeners);
            // Layer 3: the update must be forwarded over the websocket to client A
            await withTimeout(
                resolveWhenConditionIsTrue({
                    toUpdate: communityA,
                    predicate: async () => typeof communityA.updatedAt === "number"
                }),
                30_000,
                "client A post-migration record (subscription starved, see #129)"
            );
            expect(communityA.publicKey).to.equal(target.newKey);
            expect(communityA.address).to.equal(domain);

            await communityA.stop();
        } finally {
            await target.destroy();
            if (!clientA.destroyed) await clientA.destroy();
        }
    });

    itIfRpc(`subscription survives a setSettings burst during the pre-record migration window`, async () => {
        const target = await createMigrationTargetWithInvalidRecord();
        const { communityAddress: oldKey } = await createMockedCommunityIpns({});
        const domain = `churn-setsettings-${Date.now()}.bso`;
        resolverRecords.set(domain, target.newKey);

        const clientA = await createClient();
        const clientB = await createClient();
        try {
            const communityA = await subscribeMigrationVictim(clientA, domain, oldKey, target.newKey);

            // Fire a burst of settings changes from another client. Server-side each one swaps the
            // pkc instance and runs stop() + update() on every community subscription
            // (_onSettingsChange in src/rpc/src/index.ts), exactly the churn observed in the CI logs
            const rpcClientB = clientB.clients.pkcRpcClients[rpcUrl];
            await withTimeout(
                resolveWhenConditionIsTrue({
                    toUpdate: rpcClientB,
                    predicate: async () => Boolean(rpcClientB.settings?.pkcOptions),
                    eventName: "settingschange"
                }),
                30_000,
                "client B initial RPC settings"
            );
            const currentOptions = rpcClientB.settings!.pkcOptions;
            const setSettingsBurst = [1, 2, 3].map((i) =>
                rpcClientB.setSettings({
                    pkcOptions: {
                        resolveAuthorNames: currentOptions.resolveAuthorNames,
                        validatePages: currentOptions.validatePages,
                        publishInterval: currentOptions.publishInterval,
                        updateInterval: currentOptions.updateInterval,
                        noData: currentOptions.noData,
                        httpRoutersOptions: currentOptions.httpRoutersOptions,
                        userAgent: `churn-agent-${Date.now()}-${i}`
                    }
                })
            );
            await withTimeout(Promise.all(setSettingsBurst), 60_000, "setSettings burst");

            // End the pre-record window: the subscription must survive the churn and deliver the
            // post-migration record
            await target.publishRecord();
            await withTimeout(
                resolveWhenConditionIsTrue({
                    toUpdate: communityA,
                    predicate: async () => typeof communityA.updatedAt === "number"
                }),
                60_000,
                "client A post-migration record after setSettings burst (see #129)"
            );
            expect(communityA.publicKey).to.equal(target.newKey);
            expect(communityA.address).to.equal(domain);

            await communityA.stop();
        } finally {
            await target.destroy();
            if (!clientA.destroyed) await clientA.destroy();
            if (!clientB.destroyed) await clientB.destroy();
        }
    });

    // Regression for issue #129 (setSettings handler-loop abort): the server applies a settings
    // change by iterating every subscription's _onSettingsChange handler. Before the fix, one
    // throwing handler aborted the loop: the remaining subscriptions were never migrated to the
    // new pkc instance (which is destroyed ~60s later, silently killing them) and the setSettings
    // call itself rejected
    itIfRpc(`a throwing settings-change handler must not abort the settings loop or starve other subscriptions`, async () => {
        // A community whose record can be re-published with a newer updatedAt to prove the
        // subscription is still wired after the settings change
        const newIpns = await createNewIpns();
        const { communityRecord: templateRecord } = await createMockedCommunityIpns({});
        const publishRecord = async (updatedAt: number) => {
            const record = <CommunityIpfsType>{
                ...templateRecord,
                posts: undefined,
                pubsubTopic: newIpns.signer.address,
                updatedAt
            };
            if (!record.posts) delete record.posts;
            record.signature = await signCommunity({ community: record, signer: newIpns.signer });
            await newIpns.publishToIpns(JSON.stringify(record));
        };
        const initialUpdatedAt = Math.floor(Date.now() / 1000) - 60;
        await publishRecord(initialUpdatedAt);

        const server = rpcServer as unknown as {
            _onSettingsChange: Record<string, Record<number, (args: { newPKC: PKCType }) => Promise<void>>>;
        };

        // The poisoned handler lives on its own connection created BEFORE the healthy client, so
        // the server iterates it first
        const connectionsBeforePoison = new Set(Object.keys(server._onSettingsChange));
        const clientPoison = await createClient();
        const rpcClientPoison = clientPoison.clients.pkcRpcClients[rpcUrl];
        await withTimeout(
            resolveWhenConditionIsTrue({
                toUpdate: rpcClientPoison,
                predicate: async () => Boolean(rpcClientPoison.settings?.pkcOptions),
                eventName: "settingschange"
            }),
            30_000,
            "poison client initial RPC settings"
        );
        const poisonConnectionId = Object.keys(server._onSettingsChange).find((id) => !connectionsBeforePoison.has(id));
        expect(poisonConnectionId, "poison client connection must be registered on the server").to.exist;
        // Integer-like key 1 iterates before the connection's real (large random) subscription ids
        server._onSettingsChange[poisonConnectionId!][1] = async () => {
            throw new Error("poisoned settings-change handler (#129 regression test)");
        };

        const clientB = await createClient();
        try {
            const communityB = await clientB.createCommunity({ address: newIpns.signer.address });
            await communityB.update();
            await withTimeout(
                resolveWhenConditionIsTrue({
                    toUpdate: communityB,
                    predicate: async () => communityB.updatedAt === initialUpdatedAt
                }),
                30_000,
                "client B initial community record"
            );

            const rpcClientB = clientB.clients.pkcRpcClients[rpcUrl];
            await withTimeout(
                resolveWhenConditionIsTrue({
                    toUpdate: rpcClientB,
                    predicate: async () => Boolean(rpcClientB.settings?.pkcOptions),
                    eventName: "settingschange"
                }),
                30_000,
                "client B initial RPC settings"
            );
            const currentOptions = rpcClientB.settings!.pkcOptions;
            // Before the fix this rejects with the poisoned handler's error and client B's
            // subscription is silently stranded on the to-be-destroyed old pkc
            await rpcClientB.setSettings({
                pkcOptions: {
                    resolveAuthorNames: currentOptions.resolveAuthorNames,
                    validatePages: currentOptions.validatePages,
                    publishInterval: currentOptions.publishInterval,
                    updateInterval: currentOptions.updateInterval,
                    noData: currentOptions.noData,
                    httpRoutersOptions: currentOptions.httpRoutersOptions,
                    userAgent: `poison-survivor-${Date.now()}`
                }
            });

            // The subscription must still be wired to the (new) server pkc and deliver new records
            const newerUpdatedAt = initialUpdatedAt + 60;
            await publishRecord(newerUpdatedAt);
            await withTimeout(
                resolveWhenConditionIsTrue({
                    toUpdate: communityB,
                    predicate: async () => communityB.updatedAt === newerUpdatedAt
                }),
                60_000,
                "client B record published after the settings change (see #129)"
            );

            await communityB.stop();
        } finally {
            await newIpns.pkc.destroy();
            if (!clientPoison.destroyed) await clientPoison.destroy();
            if (!clientB.destroyed) await clientB.destroy();
        }
    });
});

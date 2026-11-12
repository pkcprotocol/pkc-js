// Leak suite (#496): a PKC() whose _init() fails partway must not leave what it already started.
import { it, expect } from "vitest";
import net from "node:net";
import PKC from "../../../dist/node/index.js";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { countOpenFds, countActiveResources } from "../../helpers/leak-detection.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

const ATTEMPTS = 4;

// Linux only: the leak is read from /proc/self/fd
it.runIf(process.platform === "linux").fails(
    `PKC() rejecting ${ATTEMPTS} times (the libp2p-js client fails to start: listen port in use) leaves no helia node, fd or watcher`,
    async () => {
        // The test holds the port itself, so the trigger does not depend on which other processes are running
        const portHolder = net.createServer();
        await new Promise<void>((resolve, reject) => portHolder.once("error", reject).listen(0, "127.0.0.1", resolve));
        const heldPort = (portHolder.address() as net.AddressInfo).port;
        const goodKey = `leak-init-good-${Date.now()}`;
        const dataPath = `.tmp/leak-data-init-${Date.now()}`;
        const attempt = () =>
            PKC({
                dataPath,
                httpRoutersOptions: ["http://localhost:20001"],
                kuboRpcClientsOptions: [],
                pubsubKuboRpcClientsOptions: [],
                libp2pJsClientsOptions: [
                    // A listen port that is already held: libp2p fails to start
                    { key: goodKey, libp2pOptions: { addresses: { listen: [`/ip4/127.0.0.1/tcp/${heldPort}`] } } }
                ]
            }).then(
                async (pkc) => {
                    await pkc.destroy();
                    return "resolved";
                },
                (e: Error) => `rejected: ${String((e as { code?: string }).code ?? e.name)} ${e.message.slice(0, 120)}`
            );

        // One warm-up attempt, so one-off module state (dynamic imports, directories) is not counted
        const outcomes = [await attempt()];
        const fdsBefore = countOpenFds()!;
        const resourcesBefore = countActiveResources();
        for (let i = 0; i < ATTEMPTS; i++) outcomes.push(await attempt());
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const fdsAfter = countOpenFds()!;
        const resourcesAfter = countActiveResources();

        // What the module-level registry still holds under the good key: an existing client comes back with its
        // use count incremented, a fresh one comes back with 1
        const probe = await createLibp2pJsClientOrUseExistingOne({
            key: goodKey,
            httpRoutersOptions: ["http://localhost:20001"],
            libp2pOptions: {},
            heliaOptions: {}
        } as Parameters<typeof createLibp2pJsClientOrUseExistingOne>[0]);
        const usesHeldByFailedInits = probe.countOfUsesOfInstance - 1;
        try {
            // The trigger really fired: every attempt was rejected by the listen failure, not by something else
            expect(outcomes.filter((outcome) => !outcome.startsWith("rejected: UnsupportedListenAddressesError"))).toEqual([]);
            // The watcher is counted on its own: several fs watchers can share one inotify fd, so fdGrowth can
            // stay 0 while one watcher per failed init is left
            const fsWatchersLeft = (resourcesAfter.FSEventWrap ?? 0) - (resourcesBefore.FSEventWrap ?? 0);
            expect({ usesHeldByFailedInits, fdGrowth: fdsAfter - fdsBefore, fsWatchersLeft }).toEqual({
                usesHeldByFailedInits: 0,
                fdGrowth: 0,
                fsWatchersLeft: 0
            });
        } finally {
            await new Promise((resolve) => portHolder.close(resolve));
            while (probe.countOfUsesOfInstance > 0) await probe.heliaWithKuboRpcClientFunctions.stop();
        }
    },
    120_000
);

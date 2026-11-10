// Leak suite (#496): a PKC() whose _init() fails partway must not leave what it already started.
import { it, expect } from "vitest";
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
        const goodKey = `leak-init-good-${Date.now()}`;
        const dataPath = `.tmp/leak-data-init-${Date.now()}`;
        const attempt = () =>
            PKC({
                dataPath,
                httpRoutersOptions: ["http://localhost:20001"],
                kuboRpcClientsOptions: [],
                pubsubKuboRpcClientsOptions: [],
                libp2pJsClientsOptions: [
                    // A listen port another process already holds (the test kubo's API port): libp2p fails to start
                    { key: goodKey, libp2pOptions: { addresses: { listen: ["/ip4/127.0.0.1/tcp/15001"] } } }
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
            expect(outcomes.every((outcome) => outcome.startsWith("rejected"))).toBe(true); // the trigger really fired
            expect({ usesHeldByFailedInits, fdGrowth: fdsAfter - fdsBefore }).toEqual({ usesHeldByFailedInits: 0, fdGrowth: 0 });
        } finally {
            while (probe.countOfUsesOfInstance > 0) await probe.heliaWithKuboRpcClientFunctions.stop();
        }
    },
    120_000
);

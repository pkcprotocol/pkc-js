// Leak suite (#496): a libp2p-js PKC must not stay subscribed to the IPNS topic of every community it ever loaded.
//
// Resolving a community's IPNS name subscribes the helia node to that name's record topic. Nothing
// unsubscribes it when the last instance of that community stops, so a browser tab that visits N
// communities stays in N gossipsub meshes (and validates every record published there) until the PKC is
// destroyed. remote-loading.leak.test.ts loads one community over and over, which reuses one topic.
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

const COMMUNITIES = 5;
const [config] = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true, includeOnlyTheseTests: ["remote-libp2pjs"] });

describe.runIf(config)("leak: IPNS topics of stopped communities - libp2p-js", () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await config.pkcInstancePromise();
    });

    afterAll(async () => {
        await pkc?.destroy();
    });

    it.fails(`update + stop of ${COMMUNITIES} different communities leaves no IPNS topic subscribed`, async () => {
        const subscribedTopics = () =>
            Object.values(pkc.clients.libp2pJsClients).flatMap((client) => client._helia.libp2p.services.pubsub.getTopics());
        const before = subscribedTopics().length;
        for (let i = 0; i < COMMUNITIES; i++) {
            // A key nobody publishes under: the subscription is made before any fetch, so no record is needed
            const signer = await pkc.createSigner();
            const community = await pkc.createCommunity({ address: signer.address });
            community.on("error", () => {});
            await community.update();
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await community.stop();
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect({ topicsLeftSubscribed: subscribedTopics().length - before }).toEqual({ topicsLeftSubscribed: 0 });
    });
});

import { beforeAll } from "vitest";
// In this test we're gonna publish a couple of publications to the online sub we started in test-server.js
import Plebbit from "../../dist/node/index.js";
import {
    createOnlinePlebbit,
    fetchTestServerSubs,
    generatePostToAnswerMathQuestion,
    publishWithExpectedResult
} from "../../dist/node/test/test-util.js";

import type { Plebbit as PlebbitType } from "../../dist/node/pkc/pkc.js";

// example of browser only tests

// No need to test this in production
describe.skip("plebbit.browserLibp2pJsPublish", () => {
    let subs: Awaited<ReturnType<typeof fetchTestServerSubs>>;
    beforeAll(async () => {
        subs = await fetchTestServerSubs();
    });
    it("Can set browserLibp2pJsPublish in Plebbit correctly", async () => {
        const plebbit = await Plebbit({ browserLibp2pJsPublish: true } as any);
        expect((plebbit as any).browserLibp2pJsPublish).to.be.true;
        expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.deep.equal(["browser-libp2p-pubsub"]);
        expect(plebbit.clients.pubsubKuboRpcClients["browser-libp2p-pubsub"]).to.deep.equal({}); // should not be initialized yet, only when we pubsub publish or subscribe

        JSON.stringify(plebbit); // Will throw an error if circular json
    });

    it.skip(`Can publish a post to online sub and complete a challenge exchange`, async () => {
        const onlinePlebbit = await createOnlinePlebbit({ browserLibp2pJsPublish: true, resolveAuthorNames: false } as any);
        const post = await generatePostToAnswerMathQuestion({ communityAddress: subs.onlineSub as unknown as string }, onlinePlebbit);

        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });
});

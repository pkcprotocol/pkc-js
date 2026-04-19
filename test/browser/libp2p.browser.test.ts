import { beforeAll, expect } from "vitest";
// In this test we're gonna publish a couple of publications to the online sub we started in test-server.js
import PKC from "../../dist/node/index.js";
import {
    createOnlinePKC,
    fetchTestServerSubs,
    generatePostToAnswerMathQuestion,
    publishWithExpectedResult
} from "../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";

// example of browser only tests

// No need to test this in production
describe.skip("pkc.browserLibp2pJsPublish", () => {
    let subs: Awaited<ReturnType<typeof fetchTestServerSubs>>;
    beforeAll(async () => {
        subs = await fetchTestServerSubs();
    });
    it("Can set browserLibp2pJsPublish in PKC correctly", async () => {
        const pkc = await PKC({ browserLibp2pJsPublish: true } as any);
        expect((pkc as any).browserLibp2pJsPublish).to.be.true;
        expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.deep.equal(["browser-libp2p-pubsub"]);
        expect(pkc.clients.pubsubKuboRpcClients["browser-libp2p-pubsub"]).to.deep.equal({}); // should not be initialized yet, only when we pubsub publish or subscribe

        JSON.stringify(pkc); // Will throw an error if circular json
    });

    it.skip(`Can publish a post to online sub and complete a challenge exchange`, async () => {
        const onlinePKC = await createOnlinePKC({ browserLibp2pJsPublish: true, resolveAuthorNames: false } as any);
        const post = await generatePostToAnswerMathQuestion({ communityAddress: subs.onlineSub as unknown as string }, onlinePKC);

        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });
});

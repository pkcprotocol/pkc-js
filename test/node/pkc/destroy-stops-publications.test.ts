import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockPKC, generateMockPost, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Node-only: starts a LocalCommunity, which is not available in the browser bundle.
//
// pkc.destroy() stops updating comments, updating communities and started communities, but it
// has no registry of publications that are mid-publish, so a publication waiting on a challenge
// answer keeps running after destroy() resolves. The work it goes on to do (the challenge
// exchange, the detached stale-cache getCommunity() refresh it fires, and the community
// instances that refresh creates) is what leaves a tail of activity behind a torn-down PKC.
// See issue #270.
describe("pkc.destroy() stops in-flight publications", () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await pkc.createCommunity()) as LocalCommunity;
        // A question challenge parks the publication in waiting-challenge-answers until we answer,
        // which is never — that is what keeps it in flight while we destroy the PKC.
        await community.edit({ settings: { challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        // beforeAll may fail before pkc is assigned, and dereferencing it here would throw a TypeError
        // that replaces the real setup failure in the report.
        if (pkc && !pkc.destroyed) await pkc.destroy();
    });

    it("a publication waiting on a challenge answer is stopped by destroy()", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        post.on("error", () => {}); // the publication errors once its PKC goes away; not what we assert on

        const receivedChallenge = new Promise<void>((resolve) => post.once("challenge", () => resolve()));
        // Deliberately not awaited: publish() does not resolve until the exchange completes, and we
        // never answer the challenge.
        post.publish().catch(() => {});
        await receivedChallenge;

        expect(post.publishingState).to.not.equal("stopped");

        await pkc.destroy();

        expect(post.publishingState).to.equal("stopped");
    });
});

// Leak suite (#496): non-RPC publisher. Each test asserts the clean behaviour.
import { mockPKC, mockGatewayPKC, generateMockPost, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { it, beforeAll, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { ChallengeFileInput, ChallengeInput, ChallengeResultInput } from "../../../dist/node/community/types.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

type PublishThresholds = {
    _publishToDifferentProviderThresholdSeconds: number;
    _setProviderFailureThresholdSeconds: number;
};

const THRESHOLD_SECONDS = 2;

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
};

// Skipped under RPC: registers in-process challenge factories and drives a non-RPC publisher's watchdog
describeSkipIfRpc("leak: publications that never leave pkc._publishingPublications", () => {
    let pkc: PKCType;
    let publisherPKC: PKCType;
    let silentCommunity: LocalCommunity;
    let neverVerifyingCommunity: LocalCommunity;
    let openCommunity: LocalCommunity;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));

    const neverAnsweringChallenge = (): ChallengeFileInput => ({
        type: "text/plain",
        description: "Holds every challenge until the test is over",
        getChallenge: async () => {
            await held;
            return { success: false, error: "test is over" };
        }
    });
    const neverVerifyingChallenge = (): ChallengeFileInput => {
        const type: ChallengeInput["type"] = "text/plain";
        return {
            type,
            description: "Sends a challenge and then never verifies the answer",
            getChallenge: async (): Promise<ChallengeInput> => ({
                challenge: "1+1=?",
                type,
                verify: async (): Promise<ChallengeResultInput> => {
                    await held;
                    return { success: false, error: "test is over" };
                }
            })
        };
    };

    const startCommunity = async (challenges: { name: string }[]) => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { challenges } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        return community;
    };

    beforeAll(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = { "never-answering": neverAnsweringChallenge, "never-verifying": neverVerifyingChallenge };
        silentCommunity = await startCommunity([{ name: "never-answering" }]);
        neverVerifyingCommunity = await startCommunity([{ name: "never-verifying" }]);
        openCommunity = await startCommunity([]);
        publisherPKC = await mockGatewayPKC({
            forceMockPubsub: true,
            pkcOptions: { pubsubKuboRpcClientsOptions: ["http://localhost:15002/api/v0"] }
        });
    });

    afterAll(async () => {
        release();
        await publisherPKC?.destroy();
        await silentCommunity?.delete();
        await neverVerifyingCommunity?.delete();
        await openCommunity?.delete();
        await pkc?.destroy();
    });

    const shortenThresholds = (post: object) => {
        const internals = post as unknown as PublishThresholds;
        internals._publishToDifferentProviderThresholdSeconds = THRESHOLD_SECONDS;
        internals._setProviderFailureThresholdSeconds = THRESHOLD_SECONDS;
    };

    it.fails("a second publish() on the same instance, still unanswered, fails and unregisters like the first", async () => {
        const post = await generateMockPost({ communityAddress: silentCommunity.address, pkc: publisherPKC });
        const errors: string[] = [];
        post.on("error", (e: Error & { code?: string }) => errors.push(e.code ?? e.message));
        shortenThresholds(post);
        try {
            await post.publish();
            const firstRunLeft = await waitFor(() => !publisherPKC._publishingPublications.has(post), 30_000);
            const firstRun = { left: firstRunLeft, publishingState: post.publishingState, errors: errors.length };

            await post.publish();
            // The first run needed about 2 * THRESHOLD_SECONDS; give the second one five times that
            const secondRunLeft = await waitFor(() => !publisherPKC._publishingPublications.has(post), THRESHOLD_SECONDS * 10 * 1000);
            const secondRun = { left: secondRunLeft, publishingState: post.publishingState, errors: errors.length };

            expect({ firstRun, secondRun }).toEqual({
                firstRun: { left: true, publishingState: "failed", errors: 1 },
                secondRun: { left: true, publishingState: "failed", errors: 2 }
            });
        } finally {
            await post.stop();
        }
    });

    it.fails("an answered challenge whose verification never arrives is given up on", async () => {
        const post = await generateMockPost({ communityAddress: neverVerifyingCommunity.address, pkc: publisherPKC });
        post.on("error", () => {});
        shortenThresholds(post);
        try {
            const challenged = new Promise<void>((resolve) => post.once("challenge", () => resolve()));
            await post.publish();
            await challenged;
            await post.publishChallengeAnswers({ challengeAnswers: ["2"] });
            const left = await waitFor(() => !publisherPKC._publishingPublications.has(post), THRESHOLD_SECONDS * 10 * 1000);
            expect({ left, publishingState: post.publishingState }).toEqual({ left: true, publishingState: "failed" });
        } finally {
            await post.stop();
        }
    });
});

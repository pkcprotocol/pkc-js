// Regression (PR #503 review): the no-response watchdog of an ended publish run must not act on the
// next run of the same publication.
//
// stop() aborts the current run's controller synchronously, and publish() installs a fresh one
// synchronously, so `post.stop(); post.publish();` in one tick leaves run A's watchdog waking up in a
// later microtask while run B's controller is current. If the watchdog asks "is the run over?" of
// whatever controller is current, it sees run B, decides its own run is still alive and carries on:
// it records provider failures and re-publishes the challenge request at once, beside run B.
//
// The community never answers (its challenge hangs until teardown). The test counts the challenge
// requests the publication generates after run B starts: run B's first one, and nothing from run A.
//
// Not covered here: with stop() left un-awaited, stop()'s own async tail still marks the publication
// stopped after run B started, so run B's subscribe is abandoned. Awaiting stop() before publishing
// again avoids both problems; this test pins only the watchdog's run scoping.
import { mockPKC, mockGatewayPKC, generateMockPost, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, beforeAll, afterAll, expect, vi } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { ChallengeFileInput } from "../../../../dist/node/community/types.js";

type PublishThresholds = {
    _publishToDifferentProviderThresholdSeconds: number;
    _setProviderFailureThresholdSeconds: number;
};

type PublicationInternals = {
    _generateChallengeRequestToPublish: (...args: unknown[]) => Promise<unknown>;
};

const PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS = 4;

const waitFor = async (predicate: () => boolean): Promise<void> => {
    while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 20));
};

// Skipped under RPC: registers an in-process challenge factory via pkc.settings.challenges and drives
// a non-RPC publisher's pubsub retry watchdog directly (an RPC client delegates publishing to the server).
describeSkipIfRpc("no-response watchdog of an ended publish run", () => {
    let pkc: PKCType;
    let publisherPKC: PKCType;
    let community: LocalCommunity;
    let releaseChallenges!: () => void;
    const challengesHeld = new Promise<void>((resolve) => (releaseChallenges = resolve));

    const neverAnsweringChallenge = (): ChallengeFileInput => ({
        type: "text/plain",
        description: "Holds every challenge until the test is over",
        getChallenge: async () => {
            await challengesHeld;
            return { success: false, error: "test is over" };
        }
    });

    beforeAll(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = { "never-answering": neverAnsweringChallenge };
        community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { challenges: [{ name: "never-answering" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        // One pubsub provider, listed twice by _getPubsubProviders, so the watchdog has a second
        // provider to re-publish to. The mock pubsub clients share one in-process bus.
        publisherPKC = await mockGatewayPKC({
            forceMockPubsub: true,
            pkcOptions: { pubsubKuboRpcClientsOptions: ["http://localhost:15002/api/v0"] }
        });
    });

    afterAll(async () => {
        releaseChallenges();
        await publisherPKC?.destroy();
        await community?.delete();
        await pkc?.destroy();
    });

    it("stop() then publish() in the same tick: the first run's watchdog does not re-publish beside the second run", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc: publisherPKC });
        post.on("error", () => {});
        const internals = post as unknown as PublishThresholds & PublicationInternals;
        internals._publishToDifferentProviderThresholdSeconds = PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS;

        let requestsReceivedByCommunity = 0;
        const countRequests = (request: { comment?: { signature: { signature: string } } }) => {
            if (request.comment?.signature.signature === post.signature!.signature) requestsReceivedByCommunity += 1;
        };
        community.on("challengerequest", countRequests);
        const generateSpy = vi.spyOn(internals, "_generateChallengeRequestToPublish");
        try {
            await post.publish(); // run A; its watchdog now sleeps PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS
            await waitFor(() => requestsReceivedByCommunity >= 1);

            const stopping = post.stop(); // aborts run A synchronously
            const generatedBeforeRunB = generateSpy.mock.calls.length;
            await post.publish(); // run B, installed before run A's watchdog wakes up

            // Well inside run B's own threshold, so run B generates exactly its first request here.
            // Any further request can only come from run A's watchdog acting on run B's live controller.
            await new Promise((resolve) => setTimeout(resolve, (PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS * 1000) / 2));
            expect({ requestsGeneratedSinceRunB: generateSpy.mock.calls.length - generatedBeforeRunB }).toEqual({
                requestsGeneratedSinceRunB: 1
            });
            await stopping;
        } finally {
            generateSpy.mockRestore();
            community.removeListener("challengerequest", countRequests);
            await post.stop();
        }
    });
});

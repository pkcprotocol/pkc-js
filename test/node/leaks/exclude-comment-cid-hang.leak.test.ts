// Leak suite (#496): a challenge with exclude.community (friendly-community karma) fetches the CommentUpdate
// of each challengeCommentCids entry with no deadline. A cid whose comment names the friendly community and is signed
// by the requester, but that the friendly community never listed, never gets a CommentUpdate, so the whole challenge
// exchange (and the Comment left updating) is held until the community stops.
import { beforeAll, afterAll, it, expect } from "vitest";
import {
    addStringToIpfs,
    encryptionForSigner,
    mockPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    publishStaticCommunityWithPostInPages,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { _getCommentPendingKeyCountForTesting } from "../../../dist/node/runtime/node/community/challenges/exclude/exclude.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

type StaticFixture = Awaited<ReturnType<typeof publishStaticCommunityWithPostInPages>>;
const TTL_MS = 3000;
const inFlight = (community: LocalCommunity) =>
    (community as unknown as { _inFlightPublicationExchanges: Map<string, unknown> })._inFlightPublicationExchanges.size;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(100);
    }
    return predicate();
};

// Skipped under RPC: reads the LocalCommunity's private exchange map, which lives in the RPC server process
describeSkipIfRpc("leak: exclude.community comment cid with no CommentUpdate", () => {
    let pkc: PKCType;
    let community: LocalCommunity;
    let friendly: StaticFixture;

    beforeAll(async () => {
        friendly = await publishStaticCommunityWithPostInPages();
        pkc = await mockPKC();
        community = (await pkc.createCommunity({})) as LocalCommunity;
        await community.edit({
            settings: {
                challenges: [
                    {
                        name: "question",
                        options: { question: "1+1=?", answer: "2" },
                        exclude: [{ community: { addresses: [friendly.communityAddress], maxCommentCids: 3, postScore: 0 } }]
                    }
                ]
            }
        });
        community._challengeExchangeTtlMs = TTL_MS;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community?.delete();
        await pkc?.destroy();
        await friendly?.ipnsObj.pkc.destroy();
    });

    it.fails("the exchange is released within the challenge exchange ttl", async () => {
        // Control: an abandoned question challenge (no cids) is released by the ttl
        const control = await pkc.createComment({
            communityAddress: community.address,
            signer: await pkc.createSigner(),
            title: "control",
            content: "control"
        });
        control.on("error", () => {});
        let controlGotChallenge = false;
        control.once("challenge", () => (controlGotChallenge = true));
        void control.publish().catch(() => {});
        const controlStarted = await waitFor(() => controlGotChallenge, 20_000);
        const controlInFlightWhileWaiting = inFlight(community);
        await sleep(TTL_MS * 3);
        const controlInFlightAfterTtl = inFlight(community);
        await control.stop();

        // A CommentIpfs naming the friendly community, signed by the author, that the friendly community never listed
        const authorSigner = await pkc.createSigner();
        const commentPkc = await mockPKCNoDataPathWithOnlyKuboClient();
        const neverListed = await commentPkc.createComment({
            signer: authorSigner,
            communityAddress: friendly.communityAddress,
            title: "never listed",
            content: "never listed"
        });
        if (!neverListed.raw.pubsubMessageToPublish) {
            (neverListed as unknown as Record<string, unknown>)["_community"] = {
                address: friendly.communityAddress,
                publicKey: friendly.communityAddress,
                encryption: encryptionForSigner(friendly.ipnsObj.signer),
                pubsubTopic: friendly.communityAddress
            };
            await neverListed._signPublicationWithCommunityFields();
        }
        const neverListedCid = await addStringToIpfs(JSON.stringify({ ...neverListed.raw.pubsubMessageToPublish, depth: 0 }));
        await commentPkc.destroy();

        const post = await pkc.createComment({
            communityAddress: community.address,
            signer: authorSigner,
            title: "with a comment cid",
            content: "with a comment cid",
            challengeRequest: { challengeCommentCids: [neverListedCid] }
        });
        post.on("error", () => {});
        let postGotChallengeOrVerification = false;
        post.once("challenge", () => (postGotChallengeOrVerification = true));
        post.once("challengeverification", () => (postGotChallengeOrVerification = true));
        void post.publish().catch(() => {});
        const exchangeStarted = await waitFor(() => inFlight(community) === 1, 20_000);
        await sleep(TTL_MS * 5);
        const result = {
            controlStarted,
            controlInFlightWhileWaiting,
            controlInFlightAfterTtl,
            exchangeStarted,
            postGotChallengeOrVerification,
            inFlightAfterTtl: inFlight(community),
            getCommentPendingKeys: _getCommentPendingKeyCountForTesting(),
            updatingComments: pkc._updatingComments.size()
        };
        await post.stop();
        expect(result).toEqual({
            controlStarted: true,
            controlInFlightWhileWaiting: 1,
            controlInFlightAfterTtl: 0,
            exchangeStarted: true,
            postGotChallengeOrVerification: true,
            inFlightAfterTtl: 0,
            getCommentPendingKeys: 0,
            updatingComments: 0
        });
    });
});

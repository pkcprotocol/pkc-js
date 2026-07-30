// Client-side tests for settings.disablePubsubChallengeExchange (issue #229, PR #235).
//
// The node side lives in test/node/community/local-community/disable-pubsub-challenge-exchange.test.ts.
// This file covers the CLIENT side, which is why it runs in the browser too: a reader that loads a
// record without pubsubTopic must fail fast instead of timing out, so a UI can disable the reply
// affordance up front. Kind-blind: applies to normal communities and author-communities alike.
//
// The record is minted directly rather than by starting a community, so the client behaviour is
// tested against the wire shape alone, with no live community involved.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    mockRemotePKC,
    generateMockPost,
    createMockedCommunityIpns,
    resolveWhenConditionIsTrue,
    isRpcFlagOn
} from "../../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type Publication from "../../../dist/node/publications/publication.js";

// `pubsubTopic: undefined` mints the record shape a read-only community publishes
const readOnlyCommunityOpts: { pubsubTopic: string | undefined } = { pubsubTopic: undefined };

describe("reading a community record with no pubsubTopic", async () => {
    let pkc: PKCType;
    let communityAddress: string;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
        ({ communityAddress } = await createMockedCommunityIpns(readOnlyCommunityOpts));
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    async function loadCommunity() {
        const community = <RemoteCommunity>await pkc.createCommunity({ address: communityAddress });
        await community.update();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await community.stop();
        return community;
    }

    it("parses the record fine, since pubsubTopic is optional", async () => {
        const community = await loadCommunity();
        expect(community.address).to.equal(communityAddress);
        expect(community.raw.communityIpfs).to.exist;
        expect(community.encryption).to.exist;
    });

    it("treats the absence of pubsubTopic as disabled, not as an address fallback", async () => {
        const community = await loadCommunity();
        expect(community.pubsubTopic).to.be.undefined;
        // no challenge-topic routing CID may be derived from the address either
        expect(community.pubsubTopicRoutingCid).to.be.undefined;
    });

    it("exposes the disabled state on the loaded instance so a client can branch before publishing", async () => {
        const community = await loadCommunity();
        // `pubsubTopic === undefined` IS the public signal; a client disables its reply UI on it
        expect(community.raw.communityIpfs!.pubsubTopic).to.be.undefined;
        expect("pubsubTopic" in community.raw.communityIpfs!).to.be.false;
    });
});

describe("publishing to a community with the exchange disabled", async () => {
    let pkc: PKCType;
    let communityAddress: string;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
        ({ communityAddress } = await createMockedCommunityIpns(readOnlyCommunityOpts));
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    // publish() rejects on the direct path, but an RPC client's publish() resolves as soon as the
    // server accepts the request: the server owns the community lookup (it may be the one running the
    // community, in which case the local shortcut applies and publishing legitimately succeeds), so a
    // disabled exchange can only be reported afterwards, as an `error` event on the subscription.
    // Either way the client must end up with the same error code and a failed publishingState.
    async function expectFailFast(publication: Publication) {
        const emittedError = new Promise<PKCError>((resolve) => publication.once("error", (e) => resolve(<PKCError>e)));
        let thrownError: PKCError | undefined;
        try {
            await publication.publish();
        } catch (e) {
            thrownError = <PKCError>e;
        }
        if (!isRpcFlagOn()) expect(thrownError, "publish() should have thrown").to.exist;
        const error = thrownError ?? (await emittedError);
        expect(error.code).to.equal("ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED");
        return error;
    }

    it("publish() fails fast with ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED", async () => {
        const post = await generateMockPost({ communityAddress, pkc });
        await expectFailFast(post);
        expect(post.publishingState).to.equal("failed");
    });

    it("the error surfaces before any pubsub subscription is attempted", async () => {
        const post = await generateMockPost({ communityAddress, pkc });
        await expectFailFast(post);
        const subscribedTopics = Object.values(pkc._clientsManager.pubsubProviderSubscriptions).flat();
        expect(subscribedTopics).to.not.include(communityAddress);
    });

    it("the publisher never falls back to the community address as a challenge-exchange topic", async () => {
        const post = await generateMockPost({ communityAddress, pkc });
        await expectFailFast(post);
        expect(post._community!.pubsubTopic).to.be.undefined;
        // the community address must not have been repurposed as a topic anywhere in the exchange
        expect(Object.keys(post._challengeExchanges)).to.be.empty;
    });

    it("the same fast-fail applies to a vote", async () => {
        const vote = await pkc.createVote({
            communityAddress,
            commentCid: "QmUFu8fzuT1th3jMYc2ycbPktLKgWmVSD3xKmpvjs3ejMR",
            vote: 1,
            signer: await pkc.createSigner()
        });
        await expectFailFast(vote);
    });

    it("the same fast-fail applies to a CommentEdit", async () => {
        const commentEdit = await pkc.createCommentEdit({
            communityAddress,
            commentCid: "QmUFu8fzuT1th3jMYc2ycbPktLKgWmVSD3xKmpvjs3ejMR",
            content: "edited content",
            signer: await pkc.createSigner()
        });
        await expectFailFast(commentEdit);
    });

    it("the error is non-retriable, distinct from an unreachable-community timeout", async () => {
        const post = await generateMockPost({ communityAddress, pkc });
        const error = await expectFailFast(post);
        // an unreachable community surfaces as a pubsub timeout after the provider loop; this must not
        expect(error.code).to.not.equal("ERR_PUBSUB_DID_NOT_RECEIVE_RESPONSE_AFTER_PUBLISHING_CHALLENGE_REQUEST");
        expect(error.code).to.not.equal("ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS");
    });
});

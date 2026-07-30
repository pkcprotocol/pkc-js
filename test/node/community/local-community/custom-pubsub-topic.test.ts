// A community may run its challenge exchange on a pubsubTopic that is not its signer address.
// Nothing exercised that before issue #229: verification used to compare the challenge signer to the
// topic string, so a custom topic broke every exchange, and the topic-vs-setting interaction
// (issue #229 made an absent topic MEAN "disabled") has its own edge cases on top.
//
// Record-and-instance assertions run under both flavours; assertions that read the kubo node's own
// subscription list are itSkipIfRpc, since an RPC client has no kubo client of its own.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
    mockPKC,
    mockRemotePKC,
    generateMockPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    isRpcFlagOn
} from "../../../../dist/node/test/test-util.js";
import { pubsubTopicToDhtKey } from "../../../../dist/node/util.js";
import { describeSkipIfRpc, itSkipIfRpc } from "../../../helpers/conditional-tests.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

async function listSubscribedTopics(community: LocalCommunity) {
    return community._clientsManager.getDefaultKuboPubsubClient()._client.pubsub.ls();
}

async function waitTillCommunityPublishedRecord(community: LocalCommunity) {
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
}

async function waitTillRecordPubsubTopicIs(community: LocalCommunity, expectedTopic: string | undefined) {
    await resolveWhenConditionIsTrue({
        toUpdate: community,
        predicate: async () => community.raw.communityIpfs?.pubsubTopic === expectedTopic
    });
}

describe("a community with a custom pubsubTopic", async () => {
    const customTopic = "custom-topic-enabled-229";
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = <LocalCommunity>await pkc.createCommunity({ pubsubTopic: customTopic, settings: { challenges: [] } });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("keeps the custom topic on the instance and in the record", () => {
        expect(community.pubsubTopic).to.equal(customTopic);
        expect(community.raw.communityIpfs!.pubsubTopic).to.equal(customTopic);
        // the backfill must not have overwritten it with the signer address
        expect(community.pubsubTopic).to.not.equal(community.signer.address);
    });

    it("advertises a routing CID derived from the custom topic, not from the address", () => {
        expect(community.pubsubTopicRoutingCid).to.equal(pubsubTopicToDhtKey(customTopic));
        expect(community.pubsubTopicRoutingCid).to.not.equal(pubsubTopicToDhtKey(community.address));
    });

    // Reads the kubo node's subscription list, which an RPC client cannot do
    itSkipIfRpc("subscribes to the custom topic and to neither the signer address nor the address", async () => {
        const topics = await listSubscribedTopics(community);
        expect(topics).to.include(customTopic);
        expect(topics).to.not.include(community.signer.address);
        expect(topics).to.not.include(community.address);
    });
});

// The regression this PR's signer decoupling actually fixes. Before issue #229 verifyChallengeMessage
// compared the challenge signer's address to the pubsubTopic string, so a community on a custom topic
// had every CHALLENGE rejected with ERR_CHALLENGE_MSG_SIGNER_IS_NOT_COMMUNITY and no publication could
// ever complete. Needs a publisher without the community, so it cannot run over RPC: both clients
// would share the server that runs the community and take the local shortcut, which never verifies a
// pubsub signature.
describeSkipIfRpc("publishing over pubsub to a community on a custom topic", async () => {
    const customTopic = "custom-topic-publish-229";
    let ownerPkc: PKCType;
    let readerPkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        ownerPkc = await mockPKC();
        community = <LocalCommunity>await ownerPkc.createCommunity({ pubsubTopic: customTopic, settings: { challenges: [] } });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
        readerPkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await readerPkc.destroy();
        await community.delete();
        await ownerPkc.destroy();
    });

    it("a remote publisher completes the challenge exchange on the custom topic", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc: readerPkc });
        // Spy on the publication's OWN clients manager: every publication constructs its own, so the
        // PKC-level pubsubProviderSubscriptions map never sees a publication's subscriptions. Recording
        // the calls also beats reading the map afterwards, since a finished publication unsubscribes.
        const subscribeSpy = vi.spyOn(post._clientsManager, "pubsubSubscribeOnProvider");
        try {
            await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

            expect(post.cid).to.be.a("string");
            // the exchange ran on the custom topic, and the publisher never fell back to an address
            const subscribedTopics = subscribeSpy.mock.calls.map((call) => call[0]);
            expect(subscribedTopics).to.include(customTopic);
            expect(subscribedTopics).to.not.include(community.address);
            expect(subscribedTopics).to.not.include(community.signer.address);
        } finally {
            subscribeSpy.mockRestore();
        }
    });
});

describe("a custom pubsubTopic with the exchange disabled", async () => {
    const customTopic = "custom-topic-disabled-229";
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = <LocalCommunity>await pkc.createCommunity({
            pubsubTopic: customTopic,
            settings: { disablePubsubChallengeExchange: true, challenges: [] }
        });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("publishes a record without pubsubTopic even though a custom topic is configured", () => {
        expect(community.raw.communityIpfs!.pubsubTopic).to.be.undefined;
        expect("pubsubTopic" in community.raw.communityIpfs!).to.be.false;
        expect(community.pubsubTopicRoutingCid).to.be.undefined;
    });

    // The configured-but-unpublished topic is not part of what the RPC surface transmits
    itSkipIfRpc("keeps the custom topic on the instance so it survives the disable", () => {
        expect(community.pubsubTopic).to.equal(customTopic);
    });

    // Reads the kubo node's subscription list, which an RPC client cannot do
    itSkipIfRpc("never subscribes to the custom topic", async () => {
        expect(await listSubscribedTopics(community)).to.not.include(customTopic);
    });

    it("re-enabling publishes the custom topic again, not the signer address", async () => {
        await community.edit({ settings: { challenges: [], disablePubsubChallengeExchange: false } });
        await waitTillRecordPubsubTopicIs(community, customTopic);
        expect(community.raw.communityIpfs!.pubsubTopic).to.equal(customTopic);
        expect(community.pubsubTopic).to.equal(customTopic);
        expect(community.pubsubTopicRoutingCid).to.equal(pubsubTopicToDhtKey(customTopic));
    });

    // Reads the kubo node's subscription list, which an RPC client cannot do
    itSkipIfRpc("subscribes to the custom topic once the exchange is re-enabled", async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => (await listSubscribedTopics(community)).includes(customTopic)
        });
        expect(await listSubscribedTopics(community)).to.include(customTopic);
    });
});

// The published record is also what the DB's internal state is built from, so a topic-less record used
// to erase the configured topic from storage: the community came back with no topic and the next record
// fell back to the signer address, silently discarding the owner's configuration.
describe("a custom pubsubTopic survives a restart while the exchange is disabled", async () => {
    const customTopic = "custom-topic-restart-229";
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = <LocalCommunity>await pkc.createCommunity({
            pubsubTopic: customTopic,
            settings: { disablePubsubChallengeExchange: true, challenges: [] }
        });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
        const updatedAtBeforeRestart = community.updatedAt!;
        await community.stop();
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updatedAt! > updatedAtBeforeRestart });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("still publishes no pubsubTopic after the restart", () => {
        expect(community.raw.communityIpfs!.pubsubTopic).to.be.undefined;
        expect(community.pubsubTopicRoutingCid).to.be.undefined;
    });

    // Same RPC limitation as above: a configured-but-unpublished topic is not transmitted
    itSkipIfRpc("kept the custom topic across the restart rather than reverting to the signer address", () => {
        expect(community.pubsubTopic).to.equal(customTopic);
        expect(community.pubsubTopic).to.not.equal(community.signer.address);
    });

    it("publishes the custom topic, not the signer address, when re-enabled after the restart", async () => {
        await community.edit({ settings: { challenges: [], disablePubsubChallengeExchange: false } });
        await waitTillRecordPubsubTopicIs(community, customTopic);
        expect(community.raw.communityIpfs!.pubsubTopic).to.equal(customTopic);
        expect(community.raw.communityIpfs!.pubsubTopic).to.not.equal(community.signer.address);
    });
});

describe("editing pubsubTopic while the exchange is disabled", async () => {
    const originalTopic = "custom-topic-edit-original-229";
    const editedTopic = "custom-topic-edit-edited-229";
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = <LocalCommunity>await pkc.createCommunity({
            pubsubTopic: originalTopic,
            settings: { disablePubsubChallengeExchange: true, challenges: [] }
        });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    // The published pubsubTopic is resolved from the setting last, so it wins over a pending edit
    it("the edit does not leak a pubsubTopic into the record", async () => {
        const updatedAtBefore = community.updatedAt!;
        await community.edit({ pubsubTopic: editedTopic });
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updatedAt! > updatedAtBefore });
        expect(community.raw.communityIpfs!.pubsubTopic).to.be.undefined;
        if (!isRpcFlagOn()) expect(community.pubsubTopic).to.equal(editedTopic);
    });

    it("re-enabling publishes the edited topic", async () => {
        await community.edit({ settings: { challenges: [], disablePubsubChallengeExchange: false } });
        await waitTillRecordPubsubTopicIs(community, editedTopic);
        expect(community.raw.communityIpfs!.pubsubTopic).to.equal(editedTopic);
        expect(community.pubsubTopic).to.equal(editedTopic);
    });
});

describe("changing pubsubTopic while the community is started", async () => {
    const firstTopic = "custom-topic-change-first-229";
    const secondTopic = "custom-topic-change-second-229";
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = <LocalCommunity>await pkc.createCommunity({ pubsubTopic: firstTopic, settings: { challenges: [] } });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
        await community.edit({ pubsubTopic: secondTopic });
        await waitTillRecordPubsubTopicIs(community, secondTopic);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("publishes the new topic", () => {
        expect(community.raw.communityIpfs!.pubsubTopic).to.equal(secondTopic);
        expect(community.pubsubTopic).to.equal(secondTopic);
    });

    // The advertised routing CID is derived state: leaving it pinned to the old topic sends readers
    // looking for peers of a topic the community no longer runs.
    it("re-derives the advertised routing CID for the new topic", () => {
        expect(community.pubsubTopicRoutingCid).to.equal(pubsubTopicToDhtKey(secondTopic));
        expect(community.pubsubTopicRoutingCid).to.not.equal(pubsubTopicToDhtKey(firstTopic));
    });

    // Reads the kubo node's subscription list, which an RPC client cannot do
    itSkipIfRpc("subscribes to the new topic", async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => (await listSubscribedTopics(community)).includes(secondTopic)
        });
        expect(await listSubscribedTopics(community)).to.include(secondTopic);
    });

    // Otherwise the community keeps serving challenge requests on a topic it no longer advertises,
    // and the subscription leaks for the lifetime of the kubo node.
    itSkipIfRpc("stops listening on the old topic", async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => !(await listSubscribedTopics(community)).includes(firstTopic)
        });
        expect(await listSubscribedTopics(community)).to.not.include(firstTopic);
    });
});

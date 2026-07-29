// Integration tests for settings.disablePubsubChallengeExchange (issue #229).
// A read-only community stops running the challenge/publication pubsub topic and its published
// record omits pubsubTopic, which is what tells readers the exchange is disabled. Kind-blind
// LocalCommunity feature; author-communities (issue #31) inherit it for feed-only profiles.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    mockPKC,
    mockRemotePKC,
    generateMockPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";
import type {
    DecryptedChallengeMessageType,
    DecryptedChallengeVerificationMessageType
} from "../../../../dist/node/pubsub-messages/types.js";

const mathChallenge = [{ name: "question", options: { question: "1+1=?", answer: "2" } }];

async function listSubscribedTopics(community: LocalCommunity) {
    return community._clientsManager.getDefaultKuboPubsubClient()._client.pubsub.ls();
}

async function waitTillCommunityPublishedRecord(community: LocalCommunity) {
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
}

// Reads community.raw.communityIpfs and community.signer off the LocalCommunity instance, and lists
// the kubo node's subscriptions; the RPC client exposes neither the instance internals nor the node.
describeSkipIfRpc("settings.disablePubsubChallengeExchange = true", async () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = <LocalCommunity>await pkc.createCommunity({ settings: { disablePubsubChallengeExchange: true } });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("leaves pubsubTopic unset at init instead of backfilling the signer address", () => {
        expect(community.pubsubTopic).to.be.undefined;
    });

    it("publishes a record that omits pubsubTopic", () => {
        expect(community.raw.communityIpfs).to.exist;
        expect(community.raw.communityIpfs!.pubsubTopic).to.be.undefined;
        expect("pubsubTopic" in community.raw.communityIpfs!).to.be.false;
    });

    it("does not subscribe to the challenge/publication pubsub topic", async () => {
        const topics = await listSubscribedTopics(community);
        expect(topics).to.not.include(community.signer.address);
        expect(topics).to.not.include(community.address);
    });

    it("keeps minting new records, so replication over the IPNS topic is unaffected", async () => {
        const updatedAtBefore = community.updatedAt!;
        // an idle community only republishes every 15 minutes, so force the next mint with an edit
        await community.edit({ title: `read-only ${updatedAtBefore}` });
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updatedAt! > updatedAtBefore });
        expect(community.updatedAt!).to.be.greaterThan(updatedAtBefore);
        // and every subsequent mint still omits the topic
        expect(community.raw.communityIpfs!.pubsubTopic).to.be.undefined;
    });

    it("is loadable by a remote client, which sees no pubsubTopic on the record", async () => {
        const remotePkc = await mockRemotePKC();
        try {
            const loaded = await remotePkc.createCommunity({ address: community.address });
            await loaded.update();
            await resolveWhenConditionIsTrue({ toUpdate: loaded, predicate: async () => typeof loaded.updatedAt === "number" });
            await loaded.stop();
            expect(loaded.pubsubTopic).to.be.undefined;
            // the reader must not invent a challenge-topic routing CID from the address
            expect(loaded.pubsubTopicRoutingCid).to.be.undefined;
        } finally {
            await remotePkc.destroy();
        }
    });
});

// Same reason as above: asserts community.signer.address against the record and against the kubo
// node's subscription list, neither of which is reachable through the RPC client.
describeSkipIfRpc("settings.disablePubsubChallengeExchange unset or false", async () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = <LocalCommunity>await pkc.createCommunity({});
        await community.start();
        await waitTillCommunityPublishedRecord(community);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("backfills pubsubTopic to the signer address at init", () => {
        expect(community.pubsubTopic).to.equal(community.signer.address);
    });

    it("publishes the record with an explicit pubsubTopic", () => {
        expect(community.raw.communityIpfs!.pubsubTopic).to.equal(community.signer.address);
    });

    it("subscribes to the challenge/publication pubsub topic", async () => {
        const topics = await listSubscribedTopics(community);
        expect(topics).to.include(community.pubsubTopic);
    });
});

// Inspects readerPkc._clientsManager.pubsubProviderSubscriptions to prove which topics the publisher
// touched. Under RPC the publisher's pubsub work happens in the server's process, so the client-side
// subscription map stays empty and the assertion would pass without proving anything.
describeSkipIfRpc("no fallback to the community address as a challenge-exchange topic", async () => {
    let ownerPkc: PKCType;
    let readerPkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        ownerPkc = await mockPKC();
        community = <LocalCommunity>await ownerPkc.createCommunity({ settings: { disablePubsubChallengeExchange: true, challenges: [] } });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
        // A separate PKC instance never takes the local publish shortcut: _startedCommunities is
        // per-instance, so this exercises the same code path a real remote publisher would hit.
        readerPkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await readerPkc.destroy();
        await community.delete();
        await ownerPkc.destroy();
    });

    it("publish() fails fast with ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc: readerPkc });
        let error: PKCError | undefined;
        try {
            await post.publish();
        } catch (e) {
            error = <PKCError>e;
        }
        expect(error).to.exist;
        expect(error!.code).to.equal("ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED");
        expect(post.publishingState).to.equal("failed");
    });

    it("the publisher never subscribes to the community address as a challenge-exchange topic", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc: readerPkc });
        await post.publish().catch((): undefined => undefined);
        const subscribedTopics = Object.values(readerPkc._clientsManager.pubsubProviderSubscriptions).flat();
        expect(subscribedTopics).to.not.include(community.address);
        expect(subscribedTopics).to.not.include(community.signer.address);
    });

    it("the same fast-fail applies to a vote", async () => {
        const vote = await readerPkc.createVote({
            communityAddress: community.address,
            commentCid: "QmUFu8fzuT1th3jMYc2ycbPktLKgWmVSD3xKmpvjs3ejMR",
            vote: 1,
            signer: await readerPkc.createSigner()
        });
        let error: PKCError | undefined;
        try {
            await vote.publish();
        } catch (e) {
            error = <PKCError>e;
        }
        expect(error?.code).to.equal("ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED");
    });
});

// Asserts the same-process publish shortcut specifically: publish() must find the community in this
// PKC's _startedCommunities. An RPC client always takes _publishWithRpc instead, so it would exercise
// the server's shortcut rather than the branch under test.
describeSkipIfRpc("owner publishing while the exchange is disabled", async () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = <LocalCommunity>await pkc.createCommunity({
            settings: { disablePubsubChallengeExchange: true, challenges: mathChallenge }
        });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("same-process publish succeeds via the local shortcut, after answering the configured challenge", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        const challengesReceived: DecryptedChallengeMessageType[] = [];
        post.on("challenge", (challengeMsg) => {
            challengesReceived.push(challengeMsg);
            post.publishChallengeAnswers({ challengeAnswers: ["2"] });
        });

        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

        // the exchange really ran in-process rather than the publication being waved through: the
        // community issued the math question configured in settings.challenges
        expect(challengesReceived).to.have.lengthOf(1);
        expect(challengesReceived[0].challenges).to.have.lengthOf(1);
        expect(challengesReceived[0].challenges[0].challenge).to.equal(mathChallenge[0].options.question);
        expect(challengesReceived[0].challenges[0].type).to.equal("text/plain");
        expect(post.cid).to.be.a("string");
    });

    it("the local shortcut still evaluates the configured challenges", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        const challengesReceived: DecryptedChallengeMessageType[] = [];
        const verificationsReceived: DecryptedChallengeVerificationMessageType[] = [];
        post.on("challenge", (challengeMsg) => {
            challengesReceived.push(challengeMsg);
            post.publishChallengeAnswers({ challengeAnswers: ["wrong answer"] });
        });
        post.on("challengeverification", (verification) => verificationsReceived.push(verification));

        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: false });

        // the failure has to come from the question being asked and answered wrong, not from the
        // challenge never being issued: read-only mode removes the network path, not the pipeline
        expect(challengesReceived).to.have.lengthOf(1);
        expect(challengesReceived[0].challenges[0].challenge).to.equal(mathChallenge[0].options.question);
        expect(verificationsReceived).to.have.lengthOf(1);
        expect(verificationsReceived[0].challengeSuccess).to.be.false;
        expect(verificationsReceived[0].challengeErrors).to.deep.equal({ "0": "Wrong answer." });
        expect(post.cid).to.be.undefined;
    });
});

// Needs a PKC constructed with no pubsub provider at all, which the RPC client cannot express: an
// RPC client delegates every publish to the server's PKC and never consults its own pubsub clients.
describeSkipIfRpc("owner publishing in-process with no pubsub provider configured", async () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        // a node that runs only read-only communities has no reason to configure a pubsub provider
        pkc = await mockPKC({ pubsubKuboRpcClientsOptions: [] });
        community = <LocalCommunity>await pkc.createCommunity({
            settings: { disablePubsubChallengeExchange: true, challenges: [] }
        });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("has no pubsub provider to publish over", () => {
        expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.have.lengthOf(0);
        expect(Object.keys(pkc.clients.libp2pJsClients)).to.have.lengthOf(0);
    });

    it("publishes via the local shortcut instead of demanding a pubsub provider", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        expect(post.cid).to.be.a("string");
    });
});

// Watches the kubo node's subscription list flip as the sync loop reacts to the edit; the RPC client
// has no handle on the node running the community, so there is nothing to observe the toggle on.
describeSkipIfRpc("toggling the exchange at runtime", async () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = <LocalCommunity>await pkc.createCommunity({ settings: { challenges: [] } });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("enabling the setting unsubscribes on the next sync-loop iteration without a restart", async () => {
        const topic = community.pubsubTopic!;
        expect(await listSubscribedTopics(community)).to.include(topic);

        await community.edit({ settings: { challenges: [], disablePubsubChallengeExchange: true } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => !(await listSubscribedTopics(community)).includes(topic)
        });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.raw.communityIpfs?.pubsubTopic === undefined
        });
        // the custom topic string survives the disable, it just stops being published
        expect(community.pubsubTopic).to.equal(topic);
    });

    it("disabling the setting resubscribes and republishes the record with pubsubTopic present", async () => {
        const topic = community.pubsubTopic!;
        await community.edit({ settings: { challenges: [], disablePubsubChallengeExchange: false } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => (await listSubscribedTopics(community)).includes(topic)
        });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.raw.communityIpfs?.pubsubTopic === topic
        });
        expect(community.pubsubTopic).to.equal(topic);
    });
});

describe("challenge exchange topic derivation", async () => {
    const { challengeExchangePubsubTopic, communityChallengePubsubTopic } = await import(
        "../../../../dist/node/runtime/node/community/local-community/comment-updates.js"
    );

    it("returns the explicit pubsubTopic when the exchange is enabled", () => {
        const community = { pubsubTopic: "custom-topic", signer: { address: "signer-address" }, settings: {} } as unknown as LocalCommunity;
        expect(challengeExchangePubsubTopic(community)).to.equal("custom-topic");
    });

    it("falls back to the signer address, never to the community address", () => {
        const community = {
            address: "community.bso",
            pubsubTopic: undefined,
            signer: { address: "signer-address" },
            settings: {}
        } as unknown as LocalCommunity;
        expect(challengeExchangePubsubTopic(community)).to.equal("signer-address");
    });

    it("returns undefined when the exchange is disabled, while the raw topic is still resolvable", () => {
        const community = {
            pubsubTopic: "custom-topic",
            signer: { address: "signer-address" },
            settings: { disablePubsubChallengeExchange: true }
        } as unknown as LocalCommunity;
        expect(challengeExchangePubsubTopic(community)).to.be.undefined;
        // the raw derivation is what stop()/unsubscribe use, so it must ignore the setting
        expect(communityChallengePubsubTopic(community)).to.equal("custom-topic");
    });
});

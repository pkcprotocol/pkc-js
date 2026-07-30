// Integration tests for settings.disablePubsubChallengeExchange (issue #229).
// A read-only community stops running the challenge/publication pubsub topic and its published
// record omits pubsubTopic, which is what tells readers the exchange is disabled. Kind-blind
// LocalCommunity feature; author-communities (issue #31) inherit it for feed-only profiles.
//
// Most suites here run under BOTH the direct and the PKC RPC flavours: an RpcLocalCommunity
// transmits signer (minus privateKey), settings, pubsubTopic and raw.communityIpfs from the server,
// so every record-and-instance assertion is observable through an RPC client too. Only three things
// genuinely cannot be expressed over RPC, and each has its own describeSkipIfRpc suite below with
// the reason stated.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    mockPKC,
    mockRemotePKC,
    generateMockPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    isRpcFlagOn
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc, itSkipIfRpc } from "../../../helpers/conditional-tests.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";
import type {
    DecryptedChallengeMessageType,
    DecryptedChallengeVerificationMessageType
} from "../../../../dist/node/pubsub-messages/types.js";

const mathChallenge = [{ name: "question", options: { question: "1+1=?", answer: "2" } }];

// Under RPC the runtime object is an RpcLocalCommunity, but every prop these suites read is
// transmitted by the server, so the LocalCommunity cast stays accurate for what is asserted.
async function listSubscribedTopics(community: LocalCommunity) {
    return community._clientsManager.getDefaultKuboPubsubClient()._client.pubsub.ls();
}

async function waitTillCommunityPublishedRecord(community: LocalCommunity) {
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
}

describe("settings.disablePubsubChallengeExchange = true", async () => {
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

    // The challenge topic is not advertised, but the IPNS-over-pubsub topic is a separate derivation
    // and keeps being provided, which is what makes replication unaffected by the setting (issue #229)
    it("advertises no challenge-topic routing CID while keeping the IPNS one", () => {
        expect(community.pubsubTopicRoutingCid).to.be.undefined;
        expect(community.ipnsPubsubTopicRoutingCid).to.be.a("string");
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

describe("settings.disablePubsubChallengeExchange unset or false", async () => {
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

    it("advertises a challenge-topic routing CID derived from the topic", () => {
        expect(community.pubsubTopicRoutingCid).to.be.a("string");
    });
});

// Lists the kubo node's own subscriptions. An RPC client's PKC is constructed with
// pkcRpcClientsOptions only, so it has no kubo client to ask, and the node running the community
// lives in the server's process. This is the only assertion in the file that is truly RPC-proof.
describeSkipIfRpc("kubo pubsub subscriptions follow the setting", async () => {
    let pkc: PKCType;
    let disabledCommunity: LocalCommunity;
    let toggledCommunity: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        disabledCommunity = <LocalCommunity>await pkc.createCommunity({ settings: { disablePubsubChallengeExchange: true } });
        await disabledCommunity.start();
        await waitTillCommunityPublishedRecord(disabledCommunity);
        toggledCommunity = <LocalCommunity>await pkc.createCommunity({ settings: { challenges: [] } });
        await toggledCommunity.start();
        await waitTillCommunityPublishedRecord(toggledCommunity);
    });

    afterAll(async () => {
        await disabledCommunity.delete();
        await toggledCommunity.delete();
        await pkc.destroy();
    });

    it("a community created with the setting on never subscribes", async () => {
        const topics = await listSubscribedTopics(disabledCommunity);
        expect(topics).to.not.include(disabledCommunity.signer.address);
        expect(topics).to.not.include(disabledCommunity.address);
    });

    it("a community with the setting off subscribes to its topic", async () => {
        expect(await listSubscribedTopics(toggledCommunity)).to.include(toggledCommunity.pubsubTopic);
    });

    it("enabling the setting unsubscribes on the next sync-loop iteration without a restart", async () => {
        const topic = toggledCommunity.pubsubTopic!;
        await toggledCommunity.edit({ settings: { challenges: [], disablePubsubChallengeExchange: true } });
        await resolveWhenConditionIsTrue({
            toUpdate: toggledCommunity,
            predicate: async () => !(await listSubscribedTopics(toggledCommunity)).includes(topic)
        });
        expect(await listSubscribedTopics(toggledCommunity)).to.not.include(topic);
    });

    it("disabling the setting resubscribes without a restart", async () => {
        const topic = toggledCommunity.signer.address;
        await toggledCommunity.edit({ settings: { challenges: [], disablePubsubChallengeExchange: false } });
        await resolveWhenConditionIsTrue({
            toUpdate: toggledCommunity,
            predicate: async () => (await listSubscribedTopics(toggledCommunity)).includes(topic)
        });
        expect(await listSubscribedTopics(toggledCommunity)).to.include(topic);
    });
});

// Needs a publisher that does NOT have the community, which cannot exist over RPC: both PKCs would
// point at the same server, and that server runs the community, so publish() would legitimately
// succeed through the local shortcut instead of failing fast. It also inspects the client-side
// pubsubProviderSubscriptions map, which stays empty when the server owns the pubsub work.
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

// Runs in both flavours on purpose. Directly it exercises the same-process shortcut through
// pkc._startedCommunities; under RPC the same publish goes to the server that runs the community and
// takes the shortcut there, which is the documented owner path for a read-only community. Publishing
// must NOT fail fast in either case.
describe("owner publishing while the exchange is disabled", async () => {
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

// Needs a PKC constructed with no pubsub provider at all, which the RPC client cannot express: the
// server owns the providers, and an RPC client delegates every publish to it.
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

describe("toggling the exchange at runtime", async () => {
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

    // The full round trip of the only switch: the setting is off unless the owner turns it on, and
    // turning it off again has to restore the same topic the default backfill produced, not leave the
    // community permanently topic-less. Asserted against community.signer.address explicitly, since
    // that (never community.address) is what the backfill writes.
    it("defaults to the exchange enabled, with pubsubTopic backfilled to the signer address", () => {
        expect(community.settings?.disablePubsubChallengeExchange).to.be.undefined;
        expect(community.pubsubTopic).to.equal(community.signer.address);
        expect(community.raw.communityIpfs!.pubsubTopic).to.equal(community.signer.address);
    });

    it("enabling the setting drops pubsubTopic from the record without a restart", async () => {
        expect(community.pubsubTopic).to.equal(community.signer.address);

        await community.edit({ settings: { challenges: [], disablePubsubChallengeExchange: true } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.raw.communityIpfs?.pubsubTopic === undefined
        });
        expect(community.settings?.disablePubsubChallengeExchange).to.be.true;
    });

    // The configured topic survives the disable on the instance, it just stops being published. Only
    // observable directly: the RPC surface transmits the CommunityIpfs record plus signer/settings, so
    // a topic that is configured but deliberately unpublished is not part of what the server sends.
    itSkipIfRpc("keeps the configured topic on the instance while it is unpublished", () => {
        expect(community.raw.communityIpfs!.pubsubTopic).to.be.undefined;
        expect(community.pubsubTopic).to.equal(community.signer.address);
    });

    it("disabling the setting republishes the record with pubsubTopic present", async () => {
        const topic = community.signer.address;
        await community.edit({ settings: { challenges: [], disablePubsubChallengeExchange: false } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.raw.communityIpfs?.pubsubTopic === topic
        });
        // back to exactly the state the default produced, topic included
        expect(community.settings?.disablePubsubChallengeExchange).to.be.false;
        expect(community.pubsubTopic).to.equal(community.signer.address);
        expect(community.raw.communityIpfs!.pubsubTopic).to.equal(community.signer.address);
    });
});

// A reader that already loaded the enabled record has to follow the community into read-only mode.
// pubsubTopicRoutingCid used to be write-once, so it survived the record that dropped the topic and
// left the reader looking for peers of a challenge topic nobody runs.
describe("a reader watching the exchange being disabled", async () => {
    let ownerPkc: PKCType;
    let readerPkc: PKCType;
    let community: LocalCommunity;
    let reader: Awaited<ReturnType<PKCType["createCommunity"]>>;

    beforeAll(async () => {
        ownerPkc = await mockPKC();
        community = <LocalCommunity>await ownerPkc.createCommunity({ settings: { challenges: [] } });
        await community.start();
        await waitTillCommunityPublishedRecord(community);
        readerPkc = await mockRemotePKC();
        reader = await readerPkc.createCommunity({ address: community.address });
        await reader.update();
        await resolveWhenConditionIsTrue({ toUpdate: reader, predicate: async () => typeof reader.updatedAt === "number" });
    });

    afterAll(async () => {
        await reader.stop();
        await readerPkc.destroy();
        await community.delete();
        await ownerPkc.destroy();
    });

    it("starts out seeing the topic and its routing CID", () => {
        expect(reader.pubsubTopic).to.equal(community.signer.address);
        expect(reader.pubsubTopicRoutingCid).to.be.a("string");
    });

    it("clears both once the community publishes a record without pubsubTopic", async () => {
        await community.edit({ settings: { challenges: [], disablePubsubChallengeExchange: true } });
        await resolveWhenConditionIsTrue({
            toUpdate: reader,
            predicate: async () => reader.raw.communityIpfs?.pubsubTopic === undefined
        });
        expect(reader.pubsubTopic).to.be.undefined;
        expect(reader.pubsubTopicRoutingCid).to.be.undefined;
        // the IPNS side is untouched, so the reader keeps following the community's records
        expect(reader.ipnsPubsubTopicRoutingCid).to.be.a("string");
    });
});

// A community only backfills pubsubTopic when its DB is created, so everything about the setting has
// to survive coming back from the DB rather than being re-derived on every start.
describe("surviving a restart", async () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("a community created with the setting on stays topic-less after stop() and start()", async () => {
        const community = <LocalCommunity>await pkc.createCommunity({
            settings: { disablePubsubChallengeExchange: true, challenges: [] }
        });
        try {
            await community.start();
            await waitTillCommunityPublishedRecord(community);
            const updatedAtBeforeRestart = community.updatedAt!;
            await community.stop();

            await community.start();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => community.updatedAt! > updatedAtBeforeRestart
            });
            expect(community.settings?.disablePubsubChallengeExchange).to.be.true;
            expect(community.pubsubTopic).to.be.undefined;
            expect(community.raw.communityIpfs!.pubsubTopic).to.be.undefined;
        } finally {
            await community.delete();
        }
    });

    // The upgrade path for every community that predates the setting: pubsubTopic is already stored
    // in its DB, so disabling the exchange must keep it out of the record across a restart even
    // though the row still has it.
    it("a community whose topic is already in the DB keeps it out of the record after a restart", async () => {
        const community = <LocalCommunity>await pkc.createCommunity({ settings: { challenges: [] } });
        try {
            await community.start();
            await waitTillCommunityPublishedRecord(community);
            expect(community.raw.communityIpfs!.pubsubTopic).to.equal(community.signer.address);

            await community.edit({ settings: { challenges: [], disablePubsubChallengeExchange: true } });
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => community.raw.communityIpfs?.pubsubTopic === undefined
            });
            const updatedAtBeforeRestart = community.updatedAt!;
            await community.stop();

            await community.start();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => community.updatedAt! > updatedAtBeforeRestart
            });
            expect(community.settings?.disablePubsubChallengeExchange).to.be.true;
            expect(community.raw.communityIpfs!.pubsubTopic).to.be.undefined;
            // The stored topic is still in the DB row, it is simply not published. Only observable
            // directly, for the same reason as the toggle suite: the RPC surface sends the
            // CommunityIpfs record plus signer/settings, not a configured-but-unpublished topic.
            if (!isRpcFlagOn()) expect(community.pubsubTopic).to.equal(community.signer.address);
        } finally {
            await community.delete();
        }
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

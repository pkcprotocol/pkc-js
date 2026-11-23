import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { peerIdFromString } from "@libp2p/peer-id";
import {
    createSubWithNoChallenge,
    mockPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    publishStaticCommunityWithPostInPages,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { KuboRpcClient } from "../../../dist/node/types.js";

// Issue #602. Kubo's IPNS-over-pubsub (namesys) subscribes to a name's record topic when the name is
// published or resolved through it, and keeps the subscription until `name pubsub cancel` or a daemon
// restart. pkc-js never cancelled, so a kubo node stayed subscribed to every community it had ever hosted
// or followed. Peers remember only a bounded number of topics per peer, so those leftovers pushed the
// topics of running communities out of what other nodes knew this kubo for.
//
// Skipped under RPC: the tests read the subscriptions of the kubo node the community's own PKC instance
// talks to, and under RPC the community lives in the RPC server, which uses a kubo node of its own.
describeSkipIfRpc("kubo IPNS pubsub subscriptions are released (issue #602)", () => {
    let pkc: PKCType;
    let kubo: KuboRpcClient["_client"];

    // name pubsub subs returns "/ipns/k51…" (base36); community addresses are base58 peer ids
    const subscribedIpnsNames = async () =>
        new Set((await kubo.name.pubsub.subs()).map((name) => peerIdFromString(name.replace("/ipns/", "")).toString()));
    const isSubscribed = async (ipnsName: string) => (await subscribedIpnsNames()).has(peerIdFromString(ipnsName).toString());

    beforeAll(async () => {
        pkc = await mockPKC();
        kubo = pkc._clientsManager.getDefaultKuboRpcClient()._client;
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    // The kubo behaviour the fix relies on. If a kubo upgrade changes any of these, the cancel in stop() either
    // stops being needed or stops being safe.
    it("kubo: publish and resolve subscribe, cancel unsubscribes, key rm alone does not", async () => {
        const keyName = `issue-602-${Date.now()}`;
        const key = await kubo.key.gen(keyName, { type: "ed25519" });
        try {
            const { cid } = await kubo.add("issue 602", { pin: false });
            expect(await isSubscribed(key.id)).to.equal(false);

            await kubo.name.publish(cid, { key: keyName, allowOffline: true, ttl: "1s" });
            expect(await isSubscribed(key.id), "publishing a name subscribes to it").to.equal(true);

            expect((await kubo.name.pubsub.cancel(key.id)).canceled).to.equal(true);
            expect(await isSubscribed(key.id), "cancel unsubscribes").to.equal(false);

            for await (const _path of kubo.name.resolve(key.id, { nocache: true }));
            expect(await isSubscribed(key.id), "a resolve after a cancel subscribes again").to.equal(true);

            await kubo.name.pubsub.cancel(key.id);
            await kubo.name.publish(cid, { key: keyName, allowOffline: true, ttl: "1s" });
            expect(await isSubscribed(key.id), "a publish after a cancel subscribes again").to.equal(true);

            await kubo.key.rm(keyName);
            expect(await isSubscribed(key.id), "removing the key keeps the subscription").to.equal(true);
        } finally {
            await kubo.key.rm(keyName).catch(() => {});
            await kubo.name.pubsub.cancel(key.id).catch(() => {});
        }
    });

    describe("a local community", () => {
        let community: LocalCommunity;

        const waitForNewRecord = async () => {
            const updatedAtBefore = community.updatedAt;
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number" && community.updatedAt !== updatedAtBefore
            });
        };

        beforeAll(async () => {
            community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
            await community.start();
            await waitForNewRecord();
        });

        it("is subscribed while it runs", async () => {
            expect(await isSubscribed(community.address)).to.equal(true);
        });

        it("stop() releases the subscription", async () => {
            await community.stop();
            expect(await isSubscribed(community.address)).to.equal(false);
        });

        it("starting it again subscribes again from its first publish", async () => {
            await community.edit({ description: `issue 602 ${Date.now()}` }); // a change, so the start publishes a new record
            await community.start();
            await waitForNewRecord();
            expect(await isSubscribed(community.address)).to.equal(true);
        });

        it("delete() releases the subscription, also one a later resolve brought back", async () => {
            await community.stop();
            // what a follower of this community on the same kubo node does on its next poll
            for await (const _path of kubo.name.resolve(community.address, { nocache: true }));
            expect(await isSubscribed(community.address)).to.equal(true);

            await community.delete();
            expect(await isSubscribed(community.address)).to.equal(false);
        });
    });

    describe("a followed (remote) community", () => {
        it("stop() of the last follower releases the subscription when kubo holds no key for the name", async () => {
            const fixture = await publishStaticCommunityWithPostInPages();
            const follower = await mockPKCNoDataPathWithOnlyKuboClient();
            try {
                // The fixture publishes through this kubo node with an imported key. Without the key the node only
                // follows the name: the record stays in its store, so the follower below still resolves it.
                await kubo.key.rm(fixture.communityAddress);
                await kubo.name.pubsub.cancel(fixture.communityAddress);

                const community = await follower.createCommunity({ address: fixture.communityAddress });
                await community.update();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
                expect(await isSubscribed(fixture.communityAddress), "resolving the name subscribed kubo to it").to.equal(true);

                await community.stop();
                expect(await isSubscribed(fixture.communityAddress)).to.equal(false);
            } finally {
                await follower.destroy();
                await fixture.ipnsObj.pkc.destroy();
                await kubo.name.pubsub.cancel(fixture.communityAddress).catch(() => {});
            }
        });

        // Two pkc-js processes can share one kubo node, one hosting a community and one following it. The host's
        // kubo has to stay subscribed to the record topic, or peers stop finding it as a source of the record.
        it("stop() of a follower keeps the subscription when kubo holds the key (the community is hosted on this node)", async () => {
            const hosted = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
            const follower = await mockPKCNoDataPathWithOnlyKuboClient();
            try {
                await hosted.start();
                await resolveWhenConditionIsTrue({ toUpdate: hosted, predicate: async () => typeof hosted.updatedAt === "number" });

                const community = await follower.createCommunity({ address: hosted.address });
                await community.update();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
                await community.stop();

                expect(await isSubscribed(hosted.address)).to.equal(true);
            } finally {
                await follower.destroy();
                await hosted.delete();
            }
        });
    });
});

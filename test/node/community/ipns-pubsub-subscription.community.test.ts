import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { peerIdFromString } from "@libp2p/peer-id";
import {
    createMockedCommunityIpns,
    createMockNameResolver,
    createSubWithNoChallenge,
    mockPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    publishStaticCommunityWithPostInPages,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { createAnchorIpnsRecord } from "../../../dist/node/signer/index.js";
import { findUpdatingCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
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
    it("kubo: publish and resolve subscribe, cancel unsubscribes unless a resolve is running, key rm alone does not", async () => {
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

            // a name with no record anywhere: kubo keeps looking, and refuses the cancel until the request is aborted
            const nameWithoutRecord = (await pkc.createSigner()).address;
            const abortController = new AbortController();
            const resolving = (async () => {
                for await (const _path of kubo.name.resolve(nameWithoutRecord, { nocache: true, signal: abortController.signal }));
            })().catch(() => {});
            await vi.waitFor(async () => expect(await isSubscribed(nameWithoutRecord)).to.equal(true), { timeout: 10000, interval: 50 });
            await expect(kubo.name.pubsub.cancel(nameWithoutRecord), "cancel during a resolve").rejects.toThrow("active subscriptions");
            abortController.abort();
            await resolving;
            expect((await kubo.name.pubsub.cancel(nameWithoutRecord)).canceled, "cancel after the resolve is aborted").to.equal(true);
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

    // The host is not asked whether kubo holds a key: stopping or deleting what it hosts always releases both names.
    describe("a delegated local community", () => {
        let anchorAddress: string;
        let minterAddress: string;
        let community: LocalCommunity;

        beforeAll(async () => {
            const anchorSigner = await pkc.createSigner();
            anchorAddress = anchorSigner.address;
            community = (await createSubWithNoChallenge({ anchor: { publicKey: anchorAddress } }, pkc)) as LocalCommunity;
            minterAddress = community.signer.address;
            await community.publishAnchorRecord(await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterAddress, sequence: 0 }));
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        });

        it("is subscribed to its anchor and its minter while it runs", async () => {
            expect(await isSubscribed(anchorAddress), "anchor").to.equal(true);
            expect(await isSubscribed(minterAddress), "minter").to.equal(true);
        });

        it("stop() releases both, with the minter's key still in kubo", async () => {
            await community.stop();
            expect(await isSubscribed(anchorAddress), "anchor").to.equal(false);
            expect(await isSubscribed(minterAddress), "minter").to.equal(false);
        });

        it("delete() releases both, also when a later resolve brought them back", async () => {
            for await (const _path of kubo.name.resolve(anchorAddress, { nocache: true }));
            expect(await isSubscribed(anchorAddress), "anchor after the resolve").to.equal(true);
            expect(await isSubscribed(minterAddress), "minter after the resolve").to.equal(true);

            await community.delete();
            expect(await isSubscribed(anchorAddress), "anchor").to.equal(false);
            expect(await isSubscribed(minterAddress), "minter").to.equal(false);
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

        // A delegated community is addressed by its anchor, and its records are signed by a minter key. Kubo holds
        // the minter's key only: the anchor record is signed by the owner elsewhere and put through routing.put,
        // which is what subscribes kubo to the anchor's topic. The host puts it again only once an hour.
        it("stop() of a follower keeps both subscriptions of a delegated community hosted on this node", async () => {
            const anchorSigner = await pkc.createSigner();
            const hosted = (await createSubWithNoChallenge({ anchor: { publicKey: anchorSigner.address } }, pkc)) as LocalCommunity;
            const minterAddress = hosted.signer.address;
            const follower = await mockPKCNoDataPathWithOnlyKuboClient();
            try {
                await hosted.publishAnchorRecord(
                    await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterAddress, sequence: 0 })
                );
                await hosted.start();
                await resolveWhenConditionIsTrue({ toUpdate: hosted, predicate: async () => typeof hosted.updatedAt === "number" });
                expect(await isSubscribed(anchorSigner.address), "hosting subscribed kubo to the anchor").to.equal(true);

                const community = await follower.createCommunity({ address: anchorSigner.address });
                await community.update();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
                expect(community.ipnsHops).to.deep.equal([anchorSigner.address, minterAddress]);
                await community.stop();

                expect(await isSubscribed(minterAddress), "minter").to.equal(true);
                expect(await isSubscribed(anchorSigner.address), "anchor").to.equal(true);
            } finally {
                await follower.destroy();
                await hosted.delete();
                await kubo.name.pubsub.cancel(anchorSigner.address).catch(() => {});
            }
        });

        // The anchor resolves, the minter it points to has no record. Two things used to keep the minter subscribed:
        // the follower never gets a community record, so community.ipnsHops never names the minter, and kubo goes on
        // looking for the record for a minute, during which stop() runs. stop() has to end that resolve inside kubo,
        // which refuses to cancel a name it is resolving.
        it("stop() during a resolve releases every name kubo was asked for, also one that led to no record", async () => {
            const anchorSigner = await pkc.createSigner();
            const minterSigner = await pkc.createSigner(); // never publishes
            const follower = await mockPKCNoDataPathWithOnlyKuboClient();
            try {
                const anchorRecord = await createAnchorIpnsRecord({ anchorSigner, minterIpnsName: minterSigner.address, sequence: 0 });
                for await (const _event of kubo.routing.put(`/ipns/${anchorSigner.address}`, anchorRecord, { allowOffline: true }));

                const community = await follower.createCommunity({ address: anchorSigner.address });
                community.on("error", () => {});
                await community.update();
                await vi.waitFor(async () => expect(await isSubscribed(minterSigner.address)).to.equal(true), {
                    timeout: 60000,
                    interval: 200
                });
                await community.stop();

                expect(await isSubscribed(anchorSigner.address), "anchor").to.equal(false);
                expect(await isSubscribed(minterSigner.address), "minter").to.equal(false);
            } finally {
                await follower.destroy();
                await kubo.name.pubsub.cancel(anchorSigner.address).catch(() => {});
                await kubo.name.pubsub.cancel(minterSigner.address).catch(() => {});
            }
        });

        // A name moves from one community to another while it is followed, so the follower asked kubo for the names
        // of two unrelated communities. Kubo hosting the old one says nothing about the new one.
        it("stop() releases the community a name moved to, when kubo holds the key of the one it moved from", async () => {
            const communityName = `issue-602-moved-${Date.now()}.bso`;
            const movedFrom = await createMockedCommunityIpns({ name: communityName }); // its key stays in kubo: hosted here
            const movedTo = await publishStaticCommunityWithPostInPages();
            const follower = await mockPKCNoDataPathWithOnlyKuboClient({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [createMockNameResolver({ records: new Map([[communityName, movedTo.communityAddress]]) })]
                }
            });
            try {
                await kubo.key.rm(movedTo.communityAddress); // only followed through this node
                await kubo.name.pubsub.cancel(movedTo.communityAddress);

                const community = await follower.createCommunity({ address: movedFrom.communityAddress });
                community.on("error", () => {});
                await community.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.publicKey === movedTo.communityAddress
                });
                await vi.waitFor(async () => expect(await isSubscribed(movedTo.communityAddress)).to.equal(true), {
                    timeout: 30000,
                    interval: 100
                });
                await community.stop();

                expect(await isSubscribed(movedFrom.communityAddress), "moved from, hosted here").to.equal(true);
                expect(await isSubscribed(movedTo.communityAddress), "moved to, only followed").to.equal(false);
            } finally {
                await follower.destroy();
                await movedTo.ipnsObj.pkc.destroy();
                await kubo.key.rm(movedFrom.communityAddress).catch(() => {});
                await kubo.name.pubsub.cancel(movedFrom.communityAddress).catch(() => {});
                await kubo.name.pubsub.cancel(movedTo.communityAddress).catch(() => {});
            }
        });

        describe("update() of another instance while stop() waits on kubo", () => {
            // makes the wait long enough to land in
            const slowDownCancel = (follower: PKCType) => {
                const followerKubo = Object.values(follower.clients.kuboRpcClients)[0]._client;
                const originalCancel = followerKubo.name.pubsub.cancel.bind(followerKubo.name.pubsub);
                followerKubo.name.pubsub.cancel = async (...args: Parameters<typeof originalCancel>) => {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    return originalCancel(...args);
                };
            };

            it("through the public API: the second instance keeps updating", async () => {
                const fixture = await publishStaticCommunityWithPostInPages();
                const follower = await mockPKCNoDataPathWithOnlyKuboClient();
                try {
                    await kubo.key.rm(fixture.communityAddress);
                    slowDownCancel(follower);
                    const first = await follower.createCommunity({ address: fixture.communityAddress });
                    await first.update();
                    await resolveWhenConditionIsTrue({ toUpdate: first, predicate: async () => typeof first.updatedAt === "number" });

                    const stopping = first.stop();
                    const second = await follower.createCommunity({ address: fixture.communityAddress });
                    await second.update();
                    await stopping;
                    await new Promise((resolve) => setTimeout(resolve, 500));

                    expect(second.state).to.equal("updating");
                    await resolveWhenConditionIsTrue({ toUpdate: second, predicate: async () => typeof second.updatedAt === "number" });
                } finally {
                    await follower.destroy();
                    await fixture.ipnsObj.pkc.destroy();
                    await kubo.name.pubsub.cancel(fixture.communityAddress).catch(() => {});
                }
            });

            it("when the tracked instance itself is stopped: the second instance keeps updating", async () => {
                const fixture = await publishStaticCommunityWithPostInPages();
                const follower = await mockPKCNoDataPathWithOnlyKuboClient();
                try {
                    await kubo.key.rm(fixture.communityAddress);
                    slowDownCancel(follower);
                    const first = await follower.createCommunity({ address: fixture.communityAddress });
                    await first.update();
                    await resolveWhenConditionIsTrue({ toUpdate: first, predicate: async () => typeof first.updatedAt === "number" });
                    const tracked = findUpdatingCommunity(follower, { publicKey: fixture.communityAddress });
                    expect(tracked, "the tracked updating instance").to.exist;

                    const stopping = tracked!.stop();
                    const second = await follower.createCommunity({ address: fixture.communityAddress });
                    await second.update();
                    await stopping;
                    await new Promise((resolve) => setTimeout(resolve, 500));

                    expect(second.state).to.equal("updating");
                } finally {
                    await follower.destroy();
                    await fixture.ipnsObj.pkc.destroy();
                    await kubo.name.pubsub.cancel(fixture.communityAddress).catch(() => {});
                }
            });
        });
    });
});

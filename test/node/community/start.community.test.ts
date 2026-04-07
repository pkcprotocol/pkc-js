import { beforeAll, afterAll, describe, it } from "vitest";
import {
    publishRandomPost,
    mockPKC,
    createSubWithNoChallenge,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    itSkipIfRpc,
    itIfRpc,
    resolveWhenConditionIsTrue,
    waitTillPostInCommunityPages,
    mockPKCV2,
    iterateThroughPagesToFindCommentInParentPagesInstance
} from "../../../dist/node/test/test-util.js";
import path from "path";
import fs from "fs";
import signers from "../../fixtures/signers.js";
import { v4 as uuidV4 } from "uuid";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

describe(`community.start`, async () => {
    let pkc: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });
    afterAll(async () => await pkc.destroy());

    it(`Started Sub can receive publications sequentially`, async () => {
        await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await publishRandomPost({ communityAddress: community.address, pkc: pkc });
    });

    it(`Started Sub can receive publications parallelly`, async () => {
        await Promise.all(new Array(3).fill(null).map(() => publishRandomPost({ communityAddress: community.address, pkc: pkc })));
    });

    it(`Can start a sub after stopping it`, async () => {
        const newSub = await createSubWithNoChallenge({}, pkc);
        await newSub.start();
        await resolveWhenConditionIsTrue({ toUpdate: newSub, predicate: async () => typeof newSub.updatedAt === "number" });
        await publishRandomPost({ communityAddress: newSub.address, pkc: pkc });
        await newSub.stop();
        await newSub.start();
        await publishRandomPost({ communityAddress: newSub.address, pkc: pkc });
        await newSub.stop();
    });

    itSkipIfRpc(`Sub can receive publications after pubsub topic subscription disconnects`, async () => {
        // There are cases where ipfs node can fail and be restarted
        // When that happens, the subscription to community.pubsubTopic will not be restored
        // The restoration of subscription should happen within the sync loop of Community
        const localSub = community as LocalCommunity;
        await localSub._pkc._clientsManager
            .getDefaultKuboPubsubClient()!
            // @ts-expect-error handleChallengeExchange is private but we need to access it for testing pubsub unsubscribe
            ._client.pubsub.unsubscribe(localSub.pubsubTopic!, localSub.handleChallengeExchange);
        const listedTopics = async () => await localSub._pkc._clientsManager.getDefaultKuboPubsubClient()!._client.pubsub.ls();
        expect(await listedTopics()).to.not.include(community.address);

        await new Promise((resolve) => setTimeout(resolve, localSub._pkc.publishInterval * 2));
        expect(await listedTopics()).to.include(community.address);

        await publishRandomPost({ communityAddress: community.address, pkc: pkc }); // Should receive publication since subscription to pubsub topic has been restored
    });

    it(`Community.start() will publish an update regardless if there's a new data`, async () => {
        const sub = await createSubWithNoChallenge({}, pkc);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await sub.stop();

        const sub2 = await pkc.createCommunity({ address: sub.address });
        expect(sub2.updatedAt).to.equal(sub.updatedAt);
        await sub2.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub2, predicate: async () => sub2.updatedAt !== sub.updatedAt });
        expect(sub2.updatedAt).to.not.equal(sub.updatedAt);
        await sub2.delete();
    });

    itSkipIfRpc(`community.start() recovers if the sync loop crashes once`, async () => {
        const sub = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        // @ts-expect-error _getDbInternalState is private but we need to mock it for testing
        const originalFunc = sub._getDbInternalState.bind(sub);
        // @ts-expect-error _getDbInternalState is private but we need to mock it for testing
        sub._getDbInternalState = async () => {
            throw Error("Mocking a failure in getting db internal state in tests");
        };
        publishRandomPost({ communityAddress: sub.address, pkc: pkc });
        await resolveWhenConditionIsTrue({
            toUpdate: sub,
            predicate: async () => sub.startedState === "failed",
            eventName: "startedstatechange"
        });
        expect(sub.startedState).to.equal("failed");

        // @ts-expect-error _getDbInternalState is private but we need to restore it for testing
        sub._getDbInternalState = originalFunc;

        await resolveWhenConditionIsTrue({
            toUpdate: sub,
            predicate: async () => sub.startedState !== "failed",
            eventName: "startedstatechange"
        });
        const post = await publishRandomPost({ communityAddress: sub.address, pkc: pkc });
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);
        await sub.delete();
    });

    itSkipIfRpc(`community.start() recovers if kubo API call  fails`, async () => {
        const sub = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const ipfsClient = sub._clientsManager.getDefaultKuboRpcClient()!._client;

        const originalFunc = ipfsClient.files.write;
        ipfsClient.files.write = () => {
            throw Error("Mocking a failure in copying MFS file in tests");
        };
        publishRandomPost({ communityAddress: sub.address, pkc: pkc });

        await resolveWhenConditionIsTrue({
            toUpdate: sub,
            predicate: async () => sub.startedState === "failed",
            eventName: "startedstatechange"
        });
        expect(sub.startedState).to.equal("failed");

        ipfsClient.files.write = originalFunc;

        await resolveWhenConditionIsTrue({
            toUpdate: sub,
            predicate: async () => sub.startedState !== "failed",
            eventName: "startedstatechange"
        });
        const post = await publishRandomPost({ communityAddress: sub.address, pkc: pkc });
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);
        await sub.delete();
    });
});

describe(`community.started`, async () => {
    let pkc: PKCType;
    let sub: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        pkc = await mockPKC();
        sub = await createSubWithNoChallenge({}, pkc);
    });

    afterAll(async () => {
        await sub.delete();
    });

    it(`community.started is false by default`, async () => {
        expect(sub.started).to.be.false;
    });

    it(`community.started is true after start()`, async () => {
        await sub.start();
        expect(sub.started).to.be.true;
    });

    it(`community.started is true for other instances`, async () => {
        const anotherSub = await pkc.createCommunity({ address: sub.address });
        expect(anotherSub.started).to.be.true;
    });

    it(`community.started is false after stopping`, async () => {
        await sub.stop();
        expect(sub.started).to.be.false;
    });

    it(`community.started is false for other instances after stopping`, async () => {
        const anotherSub = await pkc.createCommunity({ address: sub.address });
        expect(anotherSub.started).to.be.false;
    });

    it(`community.started is false after deleting community`, async () => {
        const anotherSub = await createSubWithNoChallenge({}, pkc);
        await anotherSub.start();
        expect(anotherSub.started).to.be.true;
        await resolveWhenConditionIsTrue({ toUpdate: anotherSub, predicate: async () => typeof anotherSub.updatedAt === "number" });
        await anotherSub.delete();
        expect(anotherSub.started).to.be.false;
    });
});
describe(`Start lock`, async () => {
    let pkc: PKCType;
    let dataPath: string;
    beforeAll(async () => {
        pkc = await mockPKC();
        if (Object.keys(pkc.clients.pkcRpcClients).length > 0) {
            dataPath = path.join(process.env.PWD!, ".pkc-rpc-server");
        } else dataPath = pkc.dataPath!;
        expect(dataPath).to.be.a("string");
    });
    it(`community.start throws if sub is already started (same Community instance)`, async () => {
        const community = await pkc.createCommunity();
        await community.start();
        expect(community.state).to.equal("started");
        try {
            await community.start();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        }
        await community.delete();
    });

    itSkipIfRpc(`community.start throws if sub is started by another Community instance`, async () => {
        // The reason why we skip it for RPC because RPC client can instantiate multiple Community instances to retrieve events from RPC server
        const community = await pkc.createCommunity();
        await community.start();
        expect(community.state).to.equal("started");
        const sameCommunity = await pkc.createCommunity({ address: community.address });
        expect(sameCommunity.state).to.equal("stopped");

        try {
            await sameCommunity.start();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        }
        await community.stop();
    });

    itSkipIfRpc(`Fail to start community if start lock is present`, async () => {
        const subSigner = await pkc.createSigner();
        const lockPath = path.join(dataPath, "communities", `${subSigner.address}.start.lock`);
        const sub = await pkc.createCommunity({ signer: subSigner });
        const sameSub = await pkc.createCommunity({ address: sub.address });
        sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => fs.existsSync(lockPath) });

        try {
            await sameSub.start();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        }
        await sub.stop();
    });

    it(`Can start community as soon as start lock is unlocked`, async () => {
        const subSigner = await pkc.createSigner();
        const lockPath = path.join(dataPath, "communities", `${subSigner.address}.start.lock`);
        expect(fs.existsSync(lockPath)).to.be.false;
        const sub = await pkc.createCommunity({ signer: subSigner });
        await sub.start();
        expect(fs.existsSync(lockPath)).to.be.true;
        const lockFileRemovedPromise = new Promise<void>((resolve) =>
            fs.watchFile(lockPath, () => {
                if (!fs.existsSync(lockPath)) resolve();
            })
        );
        await Promise.all([sub.stop(), lockFileRemovedPromise]);
        expect(fs.existsSync(lockPath)).to.be.false;

        await sub.start();
        await sub.delete();
    });

    itSkipIfRpc(`community.start will throw if user attempted to start the same sub concurrently through different instances`, async () => {
        const sub = await pkc.createCommunity();
        const sameSub = await pkc.createCommunity({ address: sub.address });

        try {
            await Promise.all([sub.start(), sameSub.start()]);
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        }
        if (sub.state === "started") await sub.stop();
        if (sameSub.state === "started") await sameSub.stop();
    });

    it(`Can start community if start lock is stale (10s)`, async () => {
        // Lock is considered stale if lock has not been updated in 10000 ms (10s)
        const sub = await createSubWithNoChallenge({}, pkc);

        const lockPath = path.join(dataPath, "communities", `${sub.address}.start.lock`);
        await fs.promises.mkdir(lockPath); // Artifically create a start lock

        try {
            await sub.start();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.be.oneOf([
                "ERR_COMMUNITY_ALREADY_STARTED",
                "ERR_CAN_NOT_LOAD_DB_IF_LOCAL_COMMUNITY_ALREADY_STARTED_IN_ANOTHER_PROCESS"
            ]);
        }
        await new Promise((resolve) => setTimeout(resolve, 11000)); // Wait for 11s for lock to be considered stale
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const post = await publishRandomPost({ communityAddress: sub.address, pkc: pkc });
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);
        await sub.delete();
    });

    itSkipIfRpc(`Community states are reset if community.start() throws`, async () => {
        const sub = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;

        // @ts-expect-error _repinCommentsIPFSIfNeeded is private but we need to mock it for testing
        sub._repinCommentsIPFSIfNeeded = async () => {
            throw Error("Mocking a failure in repinning comments in tests");
        };

        try {
            await sub.start();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as Error).message).to.equal("Mocking a failure in repinning comments in tests");
        }

        expect(sub.state).to.equal("stopped");
        expect(sub.started).to.be.false;
        expect(sub.startedState).to.equal("stopped");
    });

    itIfRpc(`rpcLocalSub.start() will throw if there is another instance that's started`, async () => {
        const sub1 = await createSubWithNoChallenge({}, pkc);

        await sub1.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub1, predicate: async () => typeof sub1.updatedAt === "number" });

        const sub2 = await pkc.createCommunity({ address: sub1.address });
        try {
            await sub2.start(); // should not fail
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED_IN_SAME_PKC_INSTANCE");
        }
    });

    itIfRpc(`rpcLocalSub.update() will receive started updates if there is another instance that's started`, async () => {
        const sub1 = await createSubWithNoChallenge({}, pkc);

        await sub1.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub1, predicate: async () => typeof sub1.updatedAt === "number" });

        const sub2 = await pkc.createCommunity({ address: sub1.address });
        await sub2.update(); // should not fail

        let receivedChallengeRequest = false;
        sub2.on("challengerequest", () => {
            receivedChallengeRequest = true;
        });

        let receivedChallengeVerification = false;

        sub2.on("challengeverification", () => {
            receivedChallengeVerification = true;
        });

        await publishRandomPost({ communityAddress: sub1.address, pkc: pkc });
        publishRandomPost({ communityAddress: sub1.address, pkc: pkc });

        await new Promise((resolve) => setTimeout(resolve, pkc.publishInterval * 2));

        await sub1.stop();
        // No need to stop sub2, since it will receive the stop update and unsubscribe by itself

        expect(receivedChallengeRequest).to.be.true;
        expect(receivedChallengeVerification).to.be.true;
        expect(sub1.updatedAt).to.equal(sub2.updatedAt);
    });

    itIfRpc(`rpcLocalSub.stop() will stop updating if it's an updating instance, even if there are other started instances`, async () => {
        const startedSub = await createSubWithNoChallenge({}, pkc);

        await startedSub.start();
        await new Promise((resolve) => startedSub.once("update", resolve));
        expect(startedSub.started).to.be.true;

        const updatingSub = await pkc.createCommunity({ address: startedSub.address });
        expect(updatingSub.started).to.be.true;
        await updatingSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: updatingSub, predicate: async () => Boolean(updatingSub.updatedAt) });
        await updatingSub.stop(); // This should stop sub1 and sub2

        await new Promise((resolve) => setTimeout(resolve, pkc.publishInterval * 2));
        expect(startedSub.started).to.be.true;
        expect(startedSub.startedState).to.not.equal("stopped");
        expect(startedSub.state).to.not.equal("stopped");

        expect(updatingSub.started).to.be.true; // the sub is still running in another instance
        expect(updatingSub.startedState).to.equal("stopped"); // the local started state got reset to stopped
        expect(updatingSub.state).to.equal("stopped");
        expect(updatingSub.updatingState).to.equal("stopped");
    });

    itIfRpc(`rpcLocalSub.delete() will delete the sub, even if rpcLocalSub wasn't the first instance to call start()`, async () => {
        const startedSub = await createSubWithNoChallenge({}, pkc);
        await startedSub.start();
        expect(startedSub.started).to.be.true;

        await resolveWhenConditionIsTrue({ toUpdate: startedSub, predicate: async () => typeof startedSub.updatedAt === "number" });

        const subToDelete = await pkc.createCommunity({ address: startedSub.address });
        expect(subToDelete.started).to.be.true;

        await subToDelete.delete();

        await new Promise((resolve) => setTimeout(resolve, pkc.publishInterval * 2));

        const localSubs = pkc.communities;
        expect(localSubs).to.not.include(startedSub.address);

        for (const sub of [startedSub, subToDelete]) {
            expect(sub.started).to.be.false;
            expect(sub.startedState).to.equal("stopped");
            expect(sub.state).to.equal("stopped");
        }
    });

    itSkipIfRpc(`community.stop() should remove stale cids and MFS paths from kubo node`, async () => {
        const sub = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await publishRandomPost({ communityAddress: sub.address, pkc: pkc });
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => sub._cidsToUnPin.size > 0 });
        await sub.stop();
        const recreatedSub = (await pkc.createCommunity({ address: sub.address })) as LocalCommunity;
        expect(recreatedSub._cidsToUnPin.size).to.equal(0);
        expect(recreatedSub._mfsPathsToRemove.size).to.equal(0);
    });
});

describe(`Publish loop resiliency`, async () => {
    let pkc: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    let remotePKC: PKCType;
    beforeAll(async () => {
        pkc = await mockPKCV2({ stubStorage: false });
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`Community can publish a new IPNS record with one of its comments having a valid ENS author address`, async () => {
        const mockPost = await pkc.createComment({
            author: { address: "plebbit.bso" },
            signer: signers[3],
            content: `Mock post - ${Date.now()}`,
            title: "Mock post title " + Date.now(),
            communityAddress: community.address
        });

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        await waitTillPostInCommunityPages(mockPost as Comment & { cid: string }, remotePKC);

        const loadedSub = await remotePKC.createCommunity({ address: community.address }); // If it can update, then it has a valid signature
        await loadedSub.update();
        await resolveWhenConditionIsTrue({
            toUpdate: loadedSub,
            predicate: async () => {
                const loadedPost = await iterateThroughPagesToFindCommentInParentPagesInstance(mockPost.cid!, loadedSub.posts!);
                return loadedPost?.cid === mockPost.cid;
            }
        });

        const loadedPost = await iterateThroughPagesToFindCommentInParentPagesInstance(mockPost.cid!, loadedSub.posts!);

        expect(loadedPost!.cid).to.equal(mockPost.cid);
        await loadedSub.stop();
    });

    it(`Community isn't publishing updates needlessly`, async () => {
        const sub = await createSubWithNoChallenge({}, pkc);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

        // there is no need to publish updates here, because we're not publishing new props or publications
        let triggerdUpdate = false;
        sub.on("update", () => {
            triggerdUpdate = true;
        });

        await new Promise((resolve) => setTimeout(resolve, pkc.publishInterval * 5));
        expect(triggerdUpdate).to.be.false; // Community should not publish update needlesly
        await sub.delete();
    });

    itSkipIfRpc(`Community can still publish an IPNS, even if its community-address text record resolves to null`, async () => {
        const sub = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await sub.edit({ address: `sub-does-not-exist-${uuidV4()}.bso` });
        // @ts-expect-error shouldResolveDomainForVerification is private but we need to mock it for testing
        sub.shouldResolveDomainForVerification = () => true;
        await sub.start();
        await new Promise((resolve) => sub.once("update", resolve));
        await sub.delete();
    });
    itSkipIfRpc(`Community can still publish an IPNS, even if all domain resolvers throw an error`, async () => {
        const sub = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        // @ts-expect-error _resolveTextRecordSingleChainProvider is private but we need to mock it for testing
        sub._clientsManager._resolveTextRecordSingleChainProvider = async () => {
            return { error: new Error("test error") };
        };
        await sub.edit({ address: `sub-does-not-exist-${uuidV4()}.bso` });
        // @ts-expect-error shouldResolveDomainForVerification is private but we need to mock it for testing
        sub.shouldResolveDomainForVerification = () => true;
        await sub.start();
        await new Promise((resolve) => sub.once("update", resolve));
        await sub.delete();
    });

    it(`A community doesn't resolve domain when verifying new IPNS record before publishing`);

    itSkipIfRpc(`Community can publish a new IPNS record with one of its comments having invalid ENS author address`, async () => {
        const mockPost = await pkc.createComment({
            author: { address: "plebbit.bso" },
            signer: signers[7], // Wrong signer
            title: "Test publishing with invalid ENS " + Date.now(),
            communityAddress: community.address
        });

        community.on("error", (err) => {
            console.log(err);
        });
        const localSub = community as LocalCommunity;
        localSub._pkc.resolveAuthorNames = false; // So the post gets accepted

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });
        localSub._pkc.resolveAuthorNames = true;

        expect(mockPost.author.address).to.equal("plebbit.bso");

        const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc }); // Stimulate an update
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);

        for (const resolveAuthorNames of [true, false]) {
            const remotePKCInstance = await mockPKCNoDataPathWithOnlyKuboClient({
                pkcOptions: { resolveAuthorNames, validatePages: true }
            });

            const loadedSub = await remotePKCInstance.getCommunity({ address: community.address });
            const mockPostInPage = loadedSub.posts!.pages.hot!.comments.find((comment) => comment.cid === mockPost.cid);
            // author.address is immutable (always name || publicKey), use nameResolved to indicate domain verification status
            expect(mockPostInPage!.author.address).to.equal("plebbit.bso");
            if (resolveAuthorNames) {
                // getCommunity stops the sub which aborts the fire-and-forget background resolution,
                // so nameResolved won't be set on the page. Instead, directly verify that the domain
                // resolves to a different address than the comment's signer (i.e. the name is invalid).
                const resolved = await remotePKCInstance._clientsManager.resolveAuthorNameIfNeeded({
                    authorAddress: "plebbit.bso"
                });
                expect(resolved).to.not.equal(mockPostInPage!.author.publicKey);
            }
        }
    });
});

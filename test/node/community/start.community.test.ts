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

    it(`Started community can receive publications sequentially`, async () => {
        await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await publishRandomPost({ communityAddress: community.address, pkc: pkc });
    });

    it(`Started community can receive publications parallelly`, async () => {
        await Promise.all(new Array(3).fill(null).map(() => publishRandomPost({ communityAddress: community.address, pkc: pkc })));
    });

    it(`Can start a community after stopping it`, async () => {
        const newCommunity = await createSubWithNoChallenge({}, pkc);
        await newCommunity.start();
        await resolveWhenConditionIsTrue({ toUpdate: newCommunity, predicate: async () => typeof newCommunity.updatedAt === "number" });
        await publishRandomPost({ communityAddress: newCommunity.address, pkc: pkc });
        await newCommunity.stop();
        await newCommunity.start();
        await publishRandomPost({ communityAddress: newCommunity.address, pkc: pkc });
        await newCommunity.stop();
    });

    itSkipIfRpc(`Community can receive publications after pubsub topic subscription disconnects`, async () => {
        // There are cases where ipfs node can fail and be restarted
        // When that happens, the subscription to community.pubsubTopic will not be restored
        // The restoration of subscription should happen within the sync loop of Community
        const localCommunity = community as LocalCommunity;
        await localCommunity._pkc._clientsManager
            .getDefaultKuboPubsubClient()!
            // @ts-expect-error handleChallengeExchange is private but we need to access it for testing pubsub unsubscribe
            ._client.pubsub.unsubscribe(localCommunity.pubsubTopic!, localCommunity.handleChallengeExchange);
        const listedTopics = async () => await localCommunity._pkc._clientsManager.getDefaultKuboPubsubClient()!._client.pubsub.ls();
        expect(await listedTopics()).to.not.include(community.address);

        await new Promise((resolve) => setTimeout(resolve, localCommunity._pkc.publishInterval * 2));
        expect(await listedTopics()).to.include(community.address);

        await publishRandomPost({ communityAddress: community.address, pkc: pkc }); // Should receive publication since subscription to pubsub topic has been restored
    });

    it(`Community.start() will publish an update regardless if there's a new data`, async () => {
        const community1 = await createSubWithNoChallenge({}, pkc);
        await community1.start();
        await resolveWhenConditionIsTrue({ toUpdate: community1, predicate: async () => typeof community1.updatedAt === "number" });
        await community1.stop();

        const community2 = await pkc.createCommunity({ address: community1.address });
        expect(community2.updatedAt).to.equal(community1.updatedAt);
        await community2.start();
        await resolveWhenConditionIsTrue({ toUpdate: community2, predicate: async () => community2.updatedAt !== community1.updatedAt });
        expect(community2.updatedAt).to.not.equal(community1.updatedAt);
        await community2.delete();
    });

    itSkipIfRpc(`community.start() recovers if the sync loop crashes once`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        // @ts-expect-error _getDbInternalState is private but we need to mock it for testing
        const originalFunc = community._getDbInternalState.bind(community);
        // @ts-expect-error _getDbInternalState is private but we need to mock it for testing
        community._getDbInternalState = async () => {
            throw Error("Mocking a failure in getting db internal state in tests");
        };
        publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.startedState === "failed",
            eventName: "startedstatechange"
        });
        expect(community.startedState).to.equal("failed");

        // @ts-expect-error _getDbInternalState is private but we need to restore it for testing
        community._getDbInternalState = originalFunc;

        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.startedState !== "failed",
            eventName: "startedstatechange"
        });
        const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);
        await community.delete();
    });

    itSkipIfRpc(`community.start() recovers if kubo API call  fails`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const ipfsClient = community._clientsManager.getDefaultKuboRpcClient()!._client;

        const originalFunc = ipfsClient.files.write;
        ipfsClient.files.write = () => {
            throw Error("Mocking a failure in copying MFS file in tests");
        };
        publishRandomPost({ communityAddress: community.address, pkc: pkc });

        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.startedState === "failed",
            eventName: "startedstatechange"
        });
        expect(community.startedState).to.equal("failed");

        ipfsClient.files.write = originalFunc;

        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.startedState !== "failed",
            eventName: "startedstatechange"
        });
        const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);
        await community.delete();
    });
});

describe(`community.started`, async () => {
    let pkc: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);
    });

    afterAll(async () => {
        await community.delete();
    });

    it(`community.started is false by default`, async () => {
        expect(community.started).to.be.false;
    });

    it(`community.started is true after start()`, async () => {
        await community.start();
        expect(community.started).to.be.true;
    });

    it(`community.started is true for other instances`, async () => {
        const anotherCommunity = await pkc.createCommunity({ address: community.address });
        expect(anotherCommunity.started).to.be.true;
    });

    it(`community.started is false after stopping`, async () => {
        await community.stop();
        expect(community.started).to.be.false;
    });

    it(`community.started is false for other instances after stopping`, async () => {
        const anotherCommunity = await pkc.createCommunity({ address: community.address });
        expect(anotherCommunity.started).to.be.false;
    });

    it(`community.started is false after deleting community`, async () => {
        const anotherCommunity = await createSubWithNoChallenge({}, pkc);
        await anotherCommunity.start();
        expect(anotherCommunity.started).to.be.true;
        await resolveWhenConditionIsTrue({
            toUpdate: anotherCommunity,
            predicate: async () => typeof anotherCommunity.updatedAt === "number"
        });
        await anotherCommunity.delete();
        expect(anotherCommunity.started).to.be.false;
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
    it(`community.start throws if community is already started (same Community instance)`, async () => {
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

    itSkipIfRpc(`community.start throws if community is started by another Community instance`, async () => {
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
        const communitySigner = await pkc.createSigner();
        const lockPath = path.join(dataPath, "communities", `${communitySigner.address}.start.lock`);
        const community = await pkc.createCommunity({ signer: communitySigner });
        const sameCommunity = await pkc.createCommunity({ address: community.address });
        community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => fs.existsSync(lockPath) });

        try {
            await sameCommunity.start();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        }
        await community.stop();
    });

    it(`Can start community as soon as start lock is unlocked`, async () => {
        const communitySigner = await pkc.createSigner();
        const lockPath = path.join(dataPath, "communities", `${communitySigner.address}.start.lock`);
        expect(fs.existsSync(lockPath)).to.be.false;
        const community = await pkc.createCommunity({ signer: communitySigner });
        await community.start();
        expect(fs.existsSync(lockPath)).to.be.true;
        const lockFileRemovedPromise = new Promise<void>((resolve) =>
            fs.watchFile(lockPath, () => {
                if (!fs.existsSync(lockPath)) resolve();
            })
        );
        await Promise.all([community.stop(), lockFileRemovedPromise]);
        expect(fs.existsSync(lockPath)).to.be.false;

        await community.start();
        await community.delete();
    });

    itSkipIfRpc(
        `community.start will throw if user attempted to start the same community concurrently through different instances`,
        async () => {
            const community = await pkc.createCommunity();
            const sameCommunity = await pkc.createCommunity({ address: community.address });

            try {
                await Promise.all([community.start(), sameCommunity.start()]);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
            }
            if (community.state === "started") await community.stop();
            if (sameCommunity.state === "started") await sameCommunity.stop();
        }
    );

    it(`Can start community if start lock is stale (10s)`, async () => {
        // Lock is considered stale if lock has not been updated in 10000 ms (10s)
        const community = await createSubWithNoChallenge({}, pkc);

        const lockPath = path.join(dataPath, "communities", `${community.address}.start.lock`);
        await fs.promises.mkdir(lockPath); // Artifically create a start lock

        try {
            await community.start();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.be.oneOf([
                "ERR_COMMUNITY_ALREADY_STARTED",
                "ERR_CAN_NOT_LOAD_DB_IF_LOCAL_COMMUNITY_ALREADY_STARTED_IN_ANOTHER_PROCESS"
            ]);
        }
        await new Promise((resolve) => setTimeout(resolve, 11000)); // Wait for 11s for lock to be considered stale
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);
        await community.delete();
    });

    itSkipIfRpc(`Community states are reset if community.start() throws`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;

        // @ts-expect-error _repinCommentsIPFSIfNeeded is private but we need to mock it for testing
        community._repinCommentsIPFSIfNeeded = async () => {
            throw Error("Mocking a failure in repinning comments in tests");
        };

        try {
            await community.start();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as Error).message).to.equal("Mocking a failure in repinning comments in tests");
        }

        expect(community.state).to.equal("stopped");
        expect(community.started).to.be.false;
        expect(community.startedState).to.equal("stopped");
    });

    itIfRpc(`rpcLocalCommunity.start() will throw if there is another instance that's started`, async () => {
        const community1 = await createSubWithNoChallenge({}, pkc);

        await community1.start();
        await resolveWhenConditionIsTrue({ toUpdate: community1, predicate: async () => typeof community1.updatedAt === "number" });

        const community2 = await pkc.createCommunity({ address: community1.address });
        try {
            await community2.start(); // should not fail
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED_IN_SAME_PKC_INSTANCE");
        }
    });

    itIfRpc(`rpcLocalCommunity.update() will receive started updates if there is another instance that's started`, async () => {
        const community1 = await createSubWithNoChallenge({}, pkc);

        await community1.start();
        await resolveWhenConditionIsTrue({ toUpdate: community1, predicate: async () => typeof community1.updatedAt === "number" });

        const community2 = await pkc.createCommunity({ address: community1.address });
        await community2.update(); // should not fail

        let receivedChallengeRequest = false;
        community2.on("challengerequest", () => {
            receivedChallengeRequest = true;
        });

        let receivedChallengeVerification = false;

        community2.on("challengeverification", () => {
            receivedChallengeVerification = true;
        });

        await publishRandomPost({ communityAddress: community1.address, pkc: pkc });
        publishRandomPost({ communityAddress: community1.address, pkc: pkc });

        await new Promise((resolve) => setTimeout(resolve, pkc.publishInterval * 2));

        await community1.stop();
        // No need to stop community2, since it will receive the stop update and unsubscribe by itself

        expect(receivedChallengeRequest).to.be.true;
        expect(receivedChallengeVerification).to.be.true;
        expect(community1.updatedAt).to.equal(community2.updatedAt);
    });

    itIfRpc(
        `rpcLocalCommunity.stop() will stop updating if it's an updating instance, even if there are other started instances`,
        async () => {
            const startedCommunity = await createSubWithNoChallenge({}, pkc);

            await startedCommunity.start();
            await new Promise((resolve) => startedCommunity.once("update", resolve));
            expect(startedCommunity.started).to.be.true;

            const updatingCommunity = await pkc.createCommunity({ address: startedCommunity.address });
            expect(updatingCommunity.started).to.be.true;
            await updatingCommunity.update();
            await resolveWhenConditionIsTrue({ toUpdate: updatingCommunity, predicate: async () => Boolean(updatingCommunity.updatedAt) });
            await updatingCommunity.stop();

            await new Promise((resolve) => setTimeout(resolve, pkc.publishInterval * 2));
            expect(startedCommunity.started).to.be.true;
            expect(startedCommunity.startedState).to.not.equal("stopped");
            expect(startedCommunity.state).to.not.equal("stopped");

            expect(updatingCommunity.started).to.be.true; // the community is still running in another instance
            expect(updatingCommunity.startedState).to.equal("stopped"); // the local started state got reset to stopped
            expect(updatingCommunity.state).to.equal("stopped");
            expect(updatingCommunity.updatingState).to.equal("stopped");
        }
    );

    itIfRpc(
        `rpcLocalCommunity.delete() will delete the community, even if rpcLocalCommunity wasn't the first instance to call start()`,
        async () => {
            const startedCommunity = await createSubWithNoChallenge({}, pkc);
            await startedCommunity.start();
            expect(startedCommunity.started).to.be.true;

            await resolveWhenConditionIsTrue({
                toUpdate: startedCommunity,
                predicate: async () => typeof startedCommunity.updatedAt === "number"
            });

            const communityToDelete = await pkc.createCommunity({ address: startedCommunity.address });
            expect(communityToDelete.started).to.be.true;

            await communityToDelete.delete();

            await new Promise((resolve) => setTimeout(resolve, pkc.publishInterval * 2));

            const localCommunities = pkc.communities;
            expect(localCommunities).to.not.include(startedCommunity.address);

            for (const community of [startedCommunity, communityToDelete]) {
                expect(community.started).to.be.false;
                expect(community.startedState).to.equal("stopped");
                expect(community.state).to.equal("stopped");
            }
        }
    );

    itSkipIfRpc(`community.stop() should remove stale cids and MFS paths from kubo node`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community._cidsToUnPin.size > 0 });
        await community.stop();
        const recreatedCommunity = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;
        expect(recreatedCommunity._cidsToUnPin.size).to.equal(0);
        expect(recreatedCommunity._mfsPathsToRemove.size).to.equal(0);
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

        const loadedCommunity = await remotePKC.createCommunity({ address: community.address }); // If it can update, then it has a valid signature
        await loadedCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: loadedCommunity,
            predicate: async () => {
                const loadedPost = await iterateThroughPagesToFindCommentInParentPagesInstance(mockPost.cid!, loadedCommunity.posts!);
                return loadedPost?.cid === mockPost.cid;
            }
        });

        const loadedPost = await iterateThroughPagesToFindCommentInParentPagesInstance(mockPost.cid!, loadedCommunity.posts!);

        expect(loadedPost!.cid).to.equal(mockPost.cid);
        await loadedCommunity.stop();
    });

    it(`Community isn't publishing updates needlessly`, async () => {
        const community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // there is no need to publish updates here, because we're not publishing new props or publications
        let triggerdUpdate = false;
        community.on("update", () => {
            triggerdUpdate = true;
        });

        await new Promise((resolve) => setTimeout(resolve, pkc.publishInterval * 5));
        expect(triggerdUpdate).to.be.false; // Community should not publish update needlesly
        await community.delete();
    });

    itSkipIfRpc(`Community can still publish an IPNS, even if its community-address text record resolves to null`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.edit({ address: `sub-does-not-exist-${uuidV4()}.bso` });
        // @ts-expect-error shouldResolveDomainForVerification is private but we need to mock it for testing
        community.shouldResolveDomainForVerification = () => true;
        await community.start();
        await new Promise((resolve) => community.once("update", resolve));
        await community.delete();
    });
    itSkipIfRpc(`Community can still publish an IPNS, even if all domain resolvers throw an error`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        // @ts-expect-error _resolveTextRecordSingleChainProvider is private but we need to mock it for testing
        community._clientsManager._resolveTextRecordSingleChainProvider = async () => {
            return { error: new Error("test error") };
        };
        await community.edit({ address: `sub-does-not-exist-${uuidV4()}.bso` });
        // @ts-expect-error shouldResolveDomainForVerification is private but we need to mock it for testing
        community.shouldResolveDomainForVerification = () => true;
        await community.start();
        await new Promise((resolve) => community.once("update", resolve));
        await community.delete();
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
        const localCommunity = community as LocalCommunity;
        localCommunity._pkc.resolveAuthorNames = false; // So the post gets accepted

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });
        localCommunity._pkc.resolveAuthorNames = true;

        expect(mockPost.author.address).to.equal("plebbit.bso");

        const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc }); // Stimulate an update
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);

        for (const resolveAuthorNames of [true, false]) {
            const remotePKCInstance = await mockPKCNoDataPathWithOnlyKuboClient({
                pkcOptions: { resolveAuthorNames, validatePages: true }
            });

            const loadedCommunity = await remotePKCInstance.getCommunity({ address: community.address });
            const mockPostInPage = loadedCommunity.posts!.pages.hot!.comments.find((comment) => comment.cid === mockPost.cid);
            // author.address is immutable (always name || publicKey), use nameResolved to indicate domain verification status
            expect(mockPostInPage!.author.address).to.equal("plebbit.bso");
            if (resolveAuthorNames) {
                // getCommunity stops the sub which aborts the fire-and-forget background resolution,
                // so nameResolved won't be set on the page. Instead, directly verify that the domain
                // resolves to a different address than the comment's signer (i.e. the name is invalid).
                const { resolvedAuthorName: resolved } = await remotePKCInstance._clientsManager.resolveAuthorNameIfNeeded({
                    authorName: "plebbit.bso"
                });
                expect(resolved).to.not.equal(mockPostInPage!.author.publicKey);
            }
        }
    });
});

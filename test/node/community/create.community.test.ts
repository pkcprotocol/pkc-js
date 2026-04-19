import {
    mockPKC,
    publishRandomPost,
    publishRandomReply,
    mockPKCV2,
    createSubWithNoChallenge,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    jsonifyCommunityAndRemoveInternalProps,
    waitTillPostInCommunityPages
} from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";
import { timestamp } from "../../../dist/node/util.js";
import signers from "../../fixtures/signers.js";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { temporaryDirectory } from "tempy";
import PKCWsServer from "../../../dist/node/rpc/src/index.js";
import PKC from "../../../dist/node/index.js";
import type { CreatePKCWsServerOptions } from "../../../dist/node/rpc/src/types.js";

import { stringify as deterministicStringify } from "safe-stable-stringify";

import * as remeda from "remeda";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { CreateNewLocalCommunityUserOptions } from "../../../dist/node/community/types.js";

describe.concurrent(`pkc.createCommunity (local)`, async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    beforeAll(async () => {
        pkc = await mockPKC({});
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await pkc.destroy();
        await remotePKC.destroy();
    });

    const _createAndValidateCommunityArgs = async (communityArgs: CreateNewLocalCommunityUserOptions) => {
        const newCommunity = (await pkc.createCommunity(communityArgs)) as LocalCommunity | RpcLocalCommunity;
        if (!("signer" in communityArgs))
            // signer shape changes after createCommunity
            expect(remeda.pick(newCommunity, Object.keys(communityArgs) as (keyof typeof communityArgs)[])).to.deep.equal(communityArgs); // the args should exist after creating immedietely
        await newCommunity.start();
        await resolveWhenConditionIsTrue({ toUpdate: newCommunity, predicate: async () => typeof newCommunity.updatedAt === "number" });
        await newCommunity.stop();

        // Community has finished its first sync loop, should have address now
        expect(newCommunity.address.startsWith("12D3")).to.be.true;
        expect(newCommunity.signer!.address).to.equal(newCommunity.address);
        const listedCommunities = pkc.communities;
        expect(listedCommunities).to.include(newCommunity.address);

        const remoteCommunity = await remotePKC.getCommunity({ address: newCommunity.address });

        const remoteCommunityJson = jsonifyCommunityAndRemoveInternalProps(remoteCommunity);

        const localCommunityJson = jsonifyCommunityAndRemoveInternalProps(newCommunity);

        expect(localCommunityJson).to.deep.equal(remoteCommunityJson);

        expect(remoteCommunity.raw.communityIpfs!).to.deep.equal(newCommunity.raw.communityIpfs!);
        return newCommunity;
    };

    ([{}, { title: `Test title - ${Date.now()}` }] as CreateNewLocalCommunityUserOptions[]).map((communityArgs) =>
        it(`createCommunity(${JSON.stringify(communityArgs)})`, async () => {
            await _createAndValidateCommunityArgs(communityArgs);
        })
    );

    it(`createCommunity({signer: await pkc.createSigner()})`, async () => {
        await _createAndValidateCommunityArgs({ signer: await pkc.createSigner() });
    });

    it(`createCommunity({signer: {privateKey, type}})`, async () => {
        const signer = await pkc.createSigner();
        await _createAndValidateCommunityArgs({ signer: { privateKey: signer.privateKey, type: signer.type } });
    });

    it(`createCommunity({roles, settings})`, async () => {
        const newEditProps: CreateNewLocalCommunityUserOptions = {
            roles: { ["hello.bso"]: { role: "admin" } },
            settings: { challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] }
        };
        const community = (await pkc.createCommunity(newEditProps)) as LocalCommunity | RpcLocalCommunity;
        expect(community.roles).to.deep.equal(newEditProps.roles);
        expect(community.settings).to.deep.equal({
            ...newEditProps.settings,
            maxPendingApprovalCount: 500,
            purgeDisapprovedCommentsOlderThan: 1210000
        });
        await community.delete();
    });

    it(`community = await createCommunity(await createCommunity)`, async () => {
        const props: CreateNewLocalCommunityUserOptions = { title: "community = await createCommunity(await createCommunity)" };
        const firstCommunity = (await pkc.createCommunity(props)) as LocalCommunity | RpcLocalCommunity;
        const createdCommunity = (await pkc.createCommunity(firstCommunity)) as LocalCommunity | RpcLocalCommunity;
        expect(createdCommunity.title).to.equal(props.title);
        expect(createdCommunity.signer!.address).to.be.a("string");
        await createdCommunity.delete();
    });

    it(`community = await createCommunity(JSON.parse(JSON.stringify(communityInstance)))`, async () => {
        const props: CreateNewLocalCommunityUserOptions = { title: Math.random() + "123" };
        const firstCommunity = (await pkc.createCommunity(props)) as LocalCommunity | RpcLocalCommunity;
        expect(firstCommunity.title).to.equal(props.title);
        const secondCommunity = (await pkc.createCommunity(JSON.parse(JSON.stringify(firstCommunity)))) as
            | LocalCommunity
            | RpcLocalCommunity;
        expect(secondCommunity.title).to.equal(props.title);

        const firstCommunityJson = jsonifyCommunityAndRemoveInternalProps(firstCommunity);
        const secondCommunityJson = jsonifyCommunityAndRemoveInternalProps(secondCommunity);
        expect(firstCommunityJson).to.deep.equal(secondCommunityJson);
    });

    it(`Can recreate a community with replies instance with pkc.createCommunity`, async () => {
        const props: CreateNewLocalCommunityUserOptions = { title: "Test hello", description: "Hello there" };
        const community = await createSubWithNoChallenge(props, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await waitTillPostInCommunityPages(post as never, pkc);
        await publishRandomReply({ parentComment: post as never, pkc: pkc });
        expect(community.posts).to.be.a("object");
        const clonedCommunity = (await pkc.createCommunity(community)) as LocalCommunity | RpcLocalCommunity;
        expect(clonedCommunity.posts).to.be.a("object");
        const internalProps = ["clients", "state", "startedState"] as const;
        const clonedCommunityJson = JSON.parse(JSON.stringify(remeda.omit(clonedCommunity, internalProps)));
        const localCommunityJson = JSON.parse(JSON.stringify(remeda.omit(community, internalProps)));
        delete clonedCommunityJson["raw"]["localCommunity"];
        delete localCommunityJson["raw"]["localCommunity"];
        expect(localCommunityJson).to.deep.equal(clonedCommunityJson);
        await community.delete();
    });

    it.skip(`createCommunity on online IPFS node doesn't take more than 10s`, async () => {
        const onlinePKC = await mockPKC({
            kuboRpcClientsOptions: ["http://localhost:15003/api/v0"],
            pubsubKuboRpcClientsOptions: [`http://localhost:15003/api/v0`]
        });
        const startTime = timestamp();
        const title = `Test online pkc`;
        const createdCommunity = (await onlinePKC.createCommunity({ title: title })) as LocalCommunity | RpcLocalCommunity;
        const endTime = timestamp();
        await createdCommunity.delete();
        expect(endTime).to.be.lessThanOrEqual(startTime + 10, "createCommunity took more than 10s in an online ipfs node");
        await onlinePKC.destroy();
    });

    it(`local community retains fields upon createCommunity(address)`, async () => {
        const title = `Test retention ${Date.now()}`;
        const community = await _createAndValidateCommunityArgs({ title });
        const createdCommunity = (await pkc.createCommunity({ address: community.address })) as LocalCommunity | RpcLocalCommunity;
        expect(createdCommunity.title).to.equal(title);
        expect(jsonifyCommunityAndRemoveInternalProps(createdCommunity)).to.deep.equal(jsonifyCommunityAndRemoveInternalProps(community));
        await createdCommunity.delete();
    });

    it(`Recreating a local community with createCommunity({address, ...extraProps}) should not override local community props`, async () => {
        const newCommunity = await createSubWithNoChallenge(
            {
                title: `Test for extra props`,
                description: "Test for description extra props"
            },
            pkc
        );
        await newCommunity.start();
        await resolveWhenConditionIsTrue({ toUpdate: newCommunity, predicate: async () => typeof newCommunity?.updatedAt === "number" });
        await newCommunity.stop();

        const createdCommunity = (await pkc.createCommunity({
            address: newCommunity.address,
            title: "nothing",
            description: "nothing also"
        })) as LocalCommunity | RpcLocalCommunity;
        expect(createdCommunity.title).to.equal(newCommunity.title);
        expect(createdCommunity.description).to.equal(newCommunity.description);

        await createdCommunity.start();
        await resolveWhenConditionIsTrue({ toUpdate: newCommunity, predicate: async () => createdCommunity.title === newCommunity.title });

        await new Promise((resolve) => createdCommunity.once("update", resolve));
        expect(createdCommunity.title).to.equal(newCommunity.title);
        expect(createdCommunity.description).to.equal(newCommunity.description);
        await createdCommunity.delete();
    });

    it(`Recreating a local running community should not stop it`, async () => {
        const community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await new Promise((resolve) => community.once("update", resolve));
        if (!community.updatedAt) await new Promise((resolve) => community.once("update", resolve));
        expect(community.startedState).to.not.equal("stopped");

        const recreatedCommunity = (await pkc.createCommunity({ address: community.address })) as LocalCommunity | RpcLocalCommunity;
        expect(recreatedCommunity.startedState).to.equal("stopped"); // startedState is only set by the actual instance, not synced across instances
        expect(community.startedState).to.not.equal("stopped");
        await community.stop();
    });

    itSkipIfRpc(`Can create a community if it's running in another PKC instance`, async () => {
        const firstPKC = await mockPKC();

        const community = (await firstPKC.createCommunity({ address: signers[0].address })) as LocalCommunity | RpcLocalCommunity; // this community is running in test-server process instance
        expect(community.updatedAt).to.be.greaterThan(0);

        await firstPKC.destroy();
    });

    itSkipIfRpc(`Can create a community if it's running in the same pkc instance`, async () => {
        const firstPKC = await mockPKC();
        const firstCommunity = (await firstPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await firstCommunity.start();
        const differentPKC = await mockPKCV2({
            pkcOptions: { dataPath: firstPKC.dataPath },
            stubStorage: false,
            mockResolve: true
        });

        const recreatedCommunity = (await differentPKC.createCommunity({ address: firstCommunity.address })) as
            | LocalCommunity
            | RpcLocalCommunity;
        expect(recreatedCommunity.startedState).to.equal("stopped");
        expect(recreatedCommunity.address).to.equal(firstCommunity.address);
        expect(recreatedCommunity.signer!.address).to.equal(firstCommunity.signer!.address);
        expect(recreatedCommunity.title).to.equal(firstCommunity.title);
        expect(recreatedCommunity.description).to.equal(firstCommunity.description);

        await firstPKC.destroy();
        await differentPKC.destroy();
    });

    it(`Fail to create a community with ENS address has a capital letter`, async () => {
        try {
            await pkc.createCommunity({ address: "testBso.bso" });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER");
        }
    });

    it(`pkc.createCommunity({address: undefined}) should throw a proper error if pkc has no data path`, async () => {
        const pkcWithNoDataPath = await mockPKCV2({ pkcOptions: { dataPath: undefined } });
        expect(pkcWithNoDataPath.dataPath).to.be.undefined;
        try {
            await pkcWithNoDataPath.createCommunity({ address: undefined });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.be.oneOf([
                "ERR_INVALID_CREATE_REMOTE_COMMUNITY_ARGS_SCHEMA",
                "ERR_INVALID_CREATE_COMMUNITY_WITH_RPC_ARGS_SCHEMA"
            ]);
        }
    });

    it(`pkc.communities shows unlocked created communities`, async () => {
        const title = "Test pkc.communities" + Date.now();
        const communitySigner = await pkc.createSigner();

        const createdCommunity = (await pkc.createCommunity({ signer: communitySigner, title: title })) as
            | LocalCommunity
            | RpcLocalCommunity;
        // At this point the community should be unlocked and ready to be recreated by another instance
        const listedCommunities = pkc.communities;
        expect(listedCommunities).to.include(createdCommunity.address);

        expect(createdCommunity.address).to.equal(communitySigner.address);
        expect(createdCommunity.title).to.equal(title);
    });
});

describe(`pkc.createCommunity - performance regression`, async () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKCV2();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`createCommunity({address}) for a stopped local community should not trigger IPNS resolution`, async () => {
        // Create a new local community (it will NOT be started)
        const newCommunity = await pkc.createCommunity();
        const address = newCommunity.address;

        // Now call createCommunity({address}) for the stopped community.
        // Before the fix, this would await community.update() on the RPC server
        // which triggered IPNS resolution, taking 60+ seconds.
        const timeoutMs = 15000;
        const result = await Promise.race([
            pkc.createCommunity({ address }).then((community) => ({ community, timedOut: false as const })),
            new Promise<{ community: undefined; timedOut: true }>((resolve) =>
                setTimeout(() => resolve({ community: undefined, timedOut: true }), timeoutMs)
            )
        ]);

        expect(result.timedOut, `createCommunity({address}) for stopped local community took longer than ${timeoutMs}ms`).to.be.false;
        expect(result.community!.address).to.equal(address);

        await newCommunity.delete();
    });

    itSkipIfRpc(`createCommunity({address}) over RPC for a stopped local community should not trigger IPNS resolution`, async () => {
        // This test creates its own RPC server to test the RPC-specific code path
        // The direct (non-RPC) case is covered by the test above
        const dataPath = temporaryDirectory();
        const rpcServerPort = 19170;

        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            pkcOptions: {
                kuboRpcClientsOptions: pkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: pkc.httpRoutersOptions,
                dataPath
            },
            startStartedCommunitysOnStartup: false
        };

        const rpcServer = await PKCWsServer.PKCWsServer(options);
        const rpcUrl = `ws://localhost:${rpcServerPort}`;
        const rpcPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

        // Create a community (not started)
        const newCommunity = await rpcPKC.createCommunity({});
        const address = newCommunity.address;

        // Now call createCommunity({address}) — before the fix this took 60s
        const timeoutMs = 15000;
        const result = await Promise.race([
            rpcPKC.createCommunity({ address }).then((community) => ({ community, timedOut: false as const })),
            new Promise<{ community: undefined; timedOut: true }>((resolve) =>
                setTimeout(() => resolve({ community: undefined, timedOut: true }), timeoutMs)
            )
        ]);

        expect(result.timedOut, `createCommunity({address}) over RPC took longer than ${timeoutMs}ms`).to.be.false;
        expect(result.community!.address).to.equal(address);

        await newCommunity.delete();
        await rpcPKC.destroy();
        await rpcServer.destroy();
    });
});

import {
    mockPKC,
    publishRandomPost,
    publishRandomReply,
    mockPKCV2,
    createSubWithNoChallenge,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    jsonifyCommunityAndRemoveInternalProps,
    waitTillPostInCommunityPages,
    itSkipIfRpc
} from "../../../dist/node/test/test-util.js";
import { timestamp } from "../../../dist/node/util.js";
import signers from "../../fixtures/signers.js";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import tempy from "tempy";
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

    const _createAndValidateSubArgs = async (subArgs: CreateNewLocalCommunityUserOptions) => {
        const newCommunity = (await pkc.createCommunity(subArgs)) as LocalCommunity | RpcLocalCommunity;
        if (!("signer" in subArgs))
            // signer shape changes after createCommunity
            expect(remeda.pick(newCommunity, Object.keys(subArgs) as (keyof typeof subArgs)[])).to.deep.equal(subArgs); // the args should exist after creating immedietely
        await newCommunity.start();
        await resolveWhenConditionIsTrue({ toUpdate: newCommunity, predicate: async () => typeof newCommunity.updatedAt === "number" });
        await newCommunity.stop();

        // Sub has finished its first sync loop, should have address now
        expect(newCommunity.address.startsWith("12D3")).to.be.true;
        expect(newCommunity.signer!.address).to.equal(newCommunity.address);
        const listedSubs = pkc.communities;
        expect(listedSubs).to.include(newCommunity.address);

        const remoteSub = await remotePKC.getCommunity({ address: newCommunity.address });

        const remoteSubJson = jsonifyCommunityAndRemoveInternalProps(remoteSub);

        const localSubRemoteJson = jsonifyCommunityAndRemoveInternalProps(newCommunity);

        expect(localSubRemoteJson).to.deep.equal(remoteSubJson);

        expect(remoteSub.raw.communityIpfs!).to.deep.equal(newCommunity.raw.communityIpfs!);
        return newCommunity;
    };

    ([{}, { title: `Test title - ${Date.now()}` }] as CreateNewLocalCommunityUserOptions[]).map((subArgs) =>
        it(`createCommunity(${JSON.stringify(subArgs)})`, async () => {
            await _createAndValidateSubArgs(subArgs);
        })
    );

    it(`createCommunity({signer: await pkc.createSigner()})`, async () => {
        await _createAndValidateSubArgs({ signer: await pkc.createSigner() });
    });

    it(`createCommunity({signer: {privateKey, type}})`, async () => {
        const signer = await pkc.createSigner();
        await _createAndValidateSubArgs({ signer: { privateKey: signer.privateKey, type: signer.type } });
    });

    it(`createCommunity({roles, settings})`, async () => {
        const newEditProps: CreateNewLocalCommunityUserOptions = {
            roles: { ["hello.bso"]: { role: "admin" } },
            settings: { challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] }
        };
        const sub = (await pkc.createCommunity(newEditProps)) as LocalCommunity | RpcLocalCommunity;
        expect(sub.roles).to.deep.equal(newEditProps.roles);
        expect(sub.settings).to.deep.equal({
            ...newEditProps.settings,
            maxPendingApprovalCount: 500,
            purgeDisapprovedCommentsOlderThan: 1210000
        });
        await sub.delete();
    });

    it(`community = await createCommunity(await createCommunity)`, async () => {
        const props: CreateNewLocalCommunityUserOptions = { title: "community = await createCommunity(await createCommunity)" };
        const firstSub = (await pkc.createCommunity(props)) as LocalCommunity | RpcLocalCommunity;
        const createdSub = (await pkc.createCommunity(firstSub)) as LocalCommunity | RpcLocalCommunity;
        expect(createdSub.title).to.equal(props.title);
        expect(createdSub.signer!.address).to.be.a("string");
        await createdSub.delete();
    });

    it(`community = await createCommunity(JSON.parse(JSON.stringify(communityInstance)))`, async () => {
        const props: CreateNewLocalCommunityUserOptions = { title: Math.random() + "123" };
        const firstSub = (await pkc.createCommunity(props)) as LocalCommunity | RpcLocalCommunity;
        expect(firstSub.title).to.equal(props.title);
        const secondSub = (await pkc.createCommunity(JSON.parse(JSON.stringify(firstSub)))) as LocalCommunity | RpcLocalCommunity;
        expect(secondSub.title).to.equal(props.title);

        const firstSubJson = jsonifyCommunityAndRemoveInternalProps(firstSub);
        const secondSubJson = jsonifyCommunityAndRemoveInternalProps(secondSub);
        expect(firstSubJson).to.deep.equal(secondSubJson);
    });

    it(`Can recreate a community with replies instance with pkc.createCommunity`, async () => {
        const props: CreateNewLocalCommunityUserOptions = { title: "Test hello", description: "Hello there" };
        const sub = await createSubWithNoChallenge(props, pkc);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const post = await publishRandomPost({ communityAddress: sub.address, pkc: pkc });
        await waitTillPostInCommunityPages(post as never, pkc);
        await publishRandomReply({ parentComment: post as never, pkc: pkc });
        expect(sub.posts).to.be.a("object");
        const clonedSub = (await pkc.createCommunity(sub)) as LocalCommunity | RpcLocalCommunity;
        expect(clonedSub.posts).to.be.a("object");
        const internalProps = ["clients", "state", "startedState"] as const;
        const clonedSubJson = JSON.parse(JSON.stringify(remeda.omit(clonedSub, internalProps)));
        const localSubJson = JSON.parse(JSON.stringify(remeda.omit(sub, internalProps)));
        delete clonedSubJson["raw"]["localCommunity"];
        delete localSubJson["raw"]["localCommunity"];
        expect(localSubJson).to.deep.equal(clonedSubJson);
        await sub.delete();
    });

    it.skip(`createCommunity on online IPFS node doesn't take more than 10s`, async () => {
        const onlinePKC = await mockPKC({
            kuboRpcClientsOptions: ["http://localhost:15003/api/v0"],
            pubsubKuboRpcClientsOptions: [`http://localhost:15003/api/v0`]
        });
        const startTime = timestamp();
        const title = `Test online pkc`;
        const createdSub = (await onlinePKC.createCommunity({ title: title })) as LocalCommunity | RpcLocalCommunity;
        const endTime = timestamp();
        await createdSub.delete();
        expect(endTime).to.be.lessThanOrEqual(startTime + 10, "createCommunity took more than 10s in an online ipfs node");
        await onlinePKC.destroy();
    });

    it(`local community retains fields upon createCommunity(address)`, async () => {
        const title = `Test retention ${Date.now()}`;
        const sub = await _createAndValidateSubArgs({ title });
        const createdSub = (await pkc.createCommunity({ address: sub.address })) as LocalCommunity | RpcLocalCommunity;
        expect(createdSub.title).to.equal(title);
        expect(jsonifyCommunityAndRemoveInternalProps(createdSub)).to.deep.equal(jsonifyCommunityAndRemoveInternalProps(sub));
        await createdSub.delete();
    });

    it(`Recreating a local sub with createCommunity({address, ...extraProps}) should not override local sub props`, async () => {
        const newSub = await createSubWithNoChallenge(
            {
                title: `Test for extra props`,
                description: "Test for description extra props"
            },
            pkc
        );
        await newSub.start();
        await resolveWhenConditionIsTrue({ toUpdate: newSub, predicate: async () => typeof newSub?.updatedAt === "number" });
        await newSub.stop();

        const createdCommunity = (await pkc.createCommunity({
            address: newSub.address,
            title: "nothing",
            description: "nothing also"
        })) as LocalCommunity | RpcLocalCommunity;
        expect(createdCommunity.title).to.equal(newSub.title);
        expect(createdCommunity.description).to.equal(newSub.description);

        await createdCommunity.start();
        await resolveWhenConditionIsTrue({ toUpdate: newSub, predicate: async () => createdCommunity.title === newSub.title });

        await new Promise((resolve) => createdCommunity.once("update", resolve));
        expect(createdCommunity.title).to.equal(newSub.title);
        expect(createdCommunity.description).to.equal(newSub.description);
        await createdCommunity.delete();
    });

    it(`Recreating a local running community should not stop it`, async () => {
        const sub = await createSubWithNoChallenge({}, pkc);
        await sub.start();
        await new Promise((resolve) => sub.once("update", resolve));
        if (!sub.updatedAt) await new Promise((resolve) => sub.once("update", resolve));
        expect(sub.startedState).to.not.equal("stopped");

        const recreatedSub = (await pkc.createCommunity({ address: sub.address })) as LocalCommunity | RpcLocalCommunity;
        expect(recreatedSub.startedState).to.equal("stopped"); // startedState is only set by the actual instance, not synced across instances
        expect(sub.startedState).to.not.equal("stopped");
        await sub.stop();
    });

    itSkipIfRpc(`Can create a community if it's running in another PKC instance`, async () => {
        const firstPKC = await mockPKC();

        const sub = (await firstPKC.createCommunity({ address: signers[0].address })) as LocalCommunity | RpcLocalCommunity; // this sub is running in test-server process instance
        expect(sub.updatedAt).to.be.greaterThan(0);

        await firstPKC.destroy();
    });

    itSkipIfRpc(`Can create a community if it's running in the same pkc instance`, async () => {
        const firstPKC = await mockPKC();
        const firstSub = (await firstPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await firstSub.start();
        const differentPKC = await mockPKCV2({
            pkcOptions: { dataPath: firstPKC.dataPath },
            stubStorage: false,
            mockResolve: true
        });

        const recreatedSub = (await differentPKC.createCommunity({ address: firstSub.address })) as LocalCommunity | RpcLocalCommunity;
        expect(recreatedSub.startedState).to.equal("stopped");
        expect(recreatedSub.address).to.equal(firstSub.address);
        expect(recreatedSub.signer!.address).to.equal(firstSub.signer!.address);
        expect(recreatedSub.title).to.equal(firstSub.title);
        expect(recreatedSub.description).to.equal(firstSub.description);

        await firstPKC.destroy();
        await differentPKC.destroy();
    });

    it(`Fail to create a sub with ENS address has a capital letter`, async () => {
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
        const subSigner = await pkc.createSigner();

        const createdCommunity = (await pkc.createCommunity({ signer: subSigner, title: title })) as LocalCommunity | RpcLocalCommunity;
        // At this point the sub should be unlocked and ready to be recreated by another instance
        const listedSubs = pkc.communities;
        expect(listedSubs).to.include(createdCommunity.address);

        expect(createdCommunity.address).to.equal(subSigner.address);
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
        // Create a new local sub (it will NOT be started)
        const newSub = await pkc.createCommunity();
        const address = newSub.address;

        // Now call createCommunity({address}) for the stopped sub.
        // Before the fix, this would await community.update() on the RPC server
        // which triggered IPNS resolution, taking 60+ seconds.
        const timeoutMs = 15000;
        const result = await Promise.race([
            pkc.createCommunity({ address }).then((sub) => ({ sub, timedOut: false as const })),
            new Promise<{ sub: undefined; timedOut: true }>((resolve) =>
                setTimeout(() => resolve({ sub: undefined, timedOut: true }), timeoutMs)
            )
        ]);

        expect(result.timedOut, `createCommunity({address}) for stopped local sub took longer than ${timeoutMs}ms`).to.be.false;
        expect(result.sub!.address).to.equal(address);

        await newSub.delete();
    });

    itSkipIfRpc(`createCommunity({address}) over RPC for a stopped local community should not trigger IPNS resolution`, async () => {
        // This test creates its own RPC server to test the RPC-specific code path
        // The direct (non-RPC) case is covered by the test above
        const dataPath = tempy.directory();
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

        // Create a sub (not started)
        const newSub = await rpcPKC.createCommunity({});
        const address = newSub.address;

        // Now call createCommunity({address}) — before the fix this took 60s
        const timeoutMs = 15000;
        const result = await Promise.race([
            rpcPKC.createCommunity({ address }).then((sub) => ({ sub, timedOut: false as const })),
            new Promise<{ sub: undefined; timedOut: true }>((resolve) =>
                setTimeout(() => resolve({ sub: undefined, timedOut: true }), timeoutMs)
            )
        ]);

        expect(result.timedOut, `createCommunity({address}) over RPC took longer than ${timeoutMs}ms`).to.be.false;
        expect(result.sub!.address).to.equal(address);

        await newSub.delete();
        await rpcPKC.destroy();
        await rpcServer.destroy();
    });
});

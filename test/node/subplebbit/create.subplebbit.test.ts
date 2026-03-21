import {
    mockPlebbit,
    publishRandomPost,
    publishRandomReply,
    mockPlebbitV2,
    createSubWithNoChallenge,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    jsonifySubplebbitAndRemoveInternalProps,
    waitTillPostInSubplebbitPages,
    itSkipIfRpc
} from "../../../dist/node/test/test-util.js";
import { timestamp } from "../../../dist/node/util.js";
import signers from "../../fixtures/signers.js";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import tempy from "tempy";
import PlebbitWsServer from "../../../dist/node/rpc/src/index.js";
import Plebbit from "../../../dist/node/index.js";
import type { CreatePlebbitWsServerOptions } from "../../../dist/node/rpc/src/types.js";

import { stringify as deterministicStringify } from "safe-stable-stringify";

import * as remeda from "remeda";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { CreateNewLocalSubplebbitUserOptions } from "../../../dist/node/subplebbit/types.js";

describe.concurrent(`plebbit.createSubplebbit (local)`, async () => {
    let plebbit: PlebbitType;
    let remotePlebbit: PlebbitType;
    beforeAll(async () => {
        plebbit = await mockPlebbit({});
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    const _createAndValidateSubArgs = async (subArgs: CreateNewLocalSubplebbitUserOptions) => {
        const newSubplebbit = (await plebbit.createSubplebbit(subArgs)) as LocalSubplebbit | RpcLocalSubplebbit;
        if (!("signer" in subArgs))
            // signer shape changes after createSubplebbit
            expect(remeda.pick(newSubplebbit, Object.keys(subArgs) as (keyof typeof subArgs)[])).to.deep.equal(subArgs); // the args should exist after creating immedietely
        await newSubplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: newSubplebbit, predicate: async () => typeof newSubplebbit.updatedAt === "number" });
        await newSubplebbit.stop();

        // Sub has finished its first sync loop, should have address now
        expect(newSubplebbit.address.startsWith("12D3")).to.be.true;
        expect(newSubplebbit.signer!.address).to.equal(newSubplebbit.address);
        const listedSubs = plebbit.subplebbits;
        expect(listedSubs).to.include(newSubplebbit.address);

        const remoteSub = await remotePlebbit.getSubplebbit({ address: newSubplebbit.address });

        const remoteSubJson = jsonifySubplebbitAndRemoveInternalProps(remoteSub);

        const localSubRemoteJson = jsonifySubplebbitAndRemoveInternalProps(newSubplebbit);

        expect(localSubRemoteJson).to.deep.equal(remoteSubJson);

        expect(remoteSub.raw.subplebbitIpfs!).to.deep.equal(newSubplebbit.raw.subplebbitIpfs!);
        return newSubplebbit;
    };

    ([{}, { title: `Test title - ${Date.now()}` }] as CreateNewLocalSubplebbitUserOptions[]).map((subArgs) =>
        it(`createSubplebbit(${JSON.stringify(subArgs)})`, async () => {
            await _createAndValidateSubArgs(subArgs);
        })
    );

    it(`createSubplebbit({signer: await plebbit.createSigner()})`, async () => {
        await _createAndValidateSubArgs({ signer: await plebbit.createSigner() });
    });

    it(`createSubplebbit({signer: {privateKey, type}})`, async () => {
        const signer = await plebbit.createSigner();
        await _createAndValidateSubArgs({ signer: { privateKey: signer.privateKey, type: signer.type } });
    });

    it(`createSubplebbit({roles, settings})`, async () => {
        const newEditProps: CreateNewLocalSubplebbitUserOptions = {
            roles: { ["hello.bso"]: { role: "admin" } },
            settings: { challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] }
        };
        const sub = (await plebbit.createSubplebbit(newEditProps)) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(sub.roles).to.deep.equal(newEditProps.roles);
        expect(sub.settings).to.deep.equal({
            ...newEditProps.settings,
            maxPendingApprovalCount: 500,
            purgeDisapprovedCommentsOlderThan: 1210000
        });
        await sub.delete();
    });

    it(`subplebbit = await createSubplebbit(await createSubplebbit)`, async () => {
        const props: CreateNewLocalSubplebbitUserOptions = { title: "subplebbit = await createSubplebbit(await createSubplebbit)" };
        const firstSub = (await plebbit.createSubplebbit(props)) as LocalSubplebbit | RpcLocalSubplebbit;
        const createdSub = (await plebbit.createSubplebbit(firstSub)) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(createdSub.title).to.equal(props.title);
        expect(createdSub.signer!.address).to.be.a("string");
        await createdSub.delete();
    });

    it(`subplebbit = await createSubplebbit(JSON.parse(JSON.stringify(subplebbitInstance)))`, async () => {
        const props: CreateNewLocalSubplebbitUserOptions = { title: Math.random() + "123" };
        const firstSub = (await plebbit.createSubplebbit(props)) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(firstSub.title).to.equal(props.title);
        const secondSub = (await plebbit.createSubplebbit(JSON.parse(JSON.stringify(firstSub)))) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(secondSub.title).to.equal(props.title);

        const firstSubJson = jsonifySubplebbitAndRemoveInternalProps(firstSub);
        const secondSubJson = jsonifySubplebbitAndRemoveInternalProps(secondSub);
        expect(firstSubJson).to.deep.equal(secondSubJson);
    });

    it(`Can recreate a subplebbit with replies instance with plebbit.createSubplebbit`, async () => {
        const props: CreateNewLocalSubplebbitUserOptions = { title: "Test hello", description: "Hello there" };
        const sub = await createSubWithNoChallenge(props, plebbit);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const post = await publishRandomPost({ subplebbitAddress: sub.address, plebbit: plebbit });
        await waitTillPostInSubplebbitPages(post as never, plebbit);
        await publishRandomReply({ parentComment: post as never, plebbit: plebbit });
        expect(sub.posts).to.be.a("object");
        const clonedSub = (await plebbit.createSubplebbit(sub)) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(clonedSub.posts).to.be.a("object");
        const internalProps = ["clients", "state", "startedState"] as const;
        const clonedSubJson = JSON.parse(JSON.stringify(remeda.omit(clonedSub, internalProps)));
        const localSubJson = JSON.parse(JSON.stringify(remeda.omit(sub, internalProps)));
        expect(localSubJson).to.deep.equal(clonedSubJson);
        await sub.delete();
    });

    it.skip(`createSubplebbit on online IPFS node doesn't take more than 10s`, async () => {
        const onlinePlebbit = await mockPlebbit({
            kuboRpcClientsOptions: ["http://localhost:15003/api/v0"],
            pubsubKuboRpcClientsOptions: [`http://localhost:15003/api/v0`]
        });
        const startTime = timestamp();
        const title = `Test online plebbit`;
        const createdSub = (await onlinePlebbit.createSubplebbit({ title: title })) as LocalSubplebbit | RpcLocalSubplebbit;
        const endTime = timestamp();
        await createdSub.delete();
        expect(endTime).to.be.lessThanOrEqual(startTime + 10, "createSubplebbit took more than 10s in an online ipfs node");
        await onlinePlebbit.destroy();
    });

    it(`local subplebbit retains fields upon createSubplebbit(address)`, async () => {
        const title = `Test retention ${Date.now()}`;
        const sub = await _createAndValidateSubArgs({ title });
        const createdSub = (await plebbit.createSubplebbit({ address: sub.address })) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(createdSub.title).to.equal(title);
        expect(deterministicStringify(createdSub)).to.equal(deterministicStringify(sub));
        await createdSub.delete();
    });

    it(`Recreating a local sub with createSubplebbit({address, ...extraProps}) should not override local sub props`, async () => {
        const newSub = await createSubWithNoChallenge(
            {
                title: `Test for extra props`,
                description: "Test for description extra props"
            },
            plebbit
        );
        await newSub.start();
        await new Promise((resolve) => newSub.once("update", resolve));
        if (!newSub.updatedAt) await new Promise((resolve) => newSub.once("update", resolve));
        await newSub.stop();

        const createdSubplebbit = (await plebbit.createSubplebbit({
            address: newSub.address,
            title: "nothing",
            description: "nothing also"
        })) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(createdSubplebbit.title).to.equal(newSub.title);
        expect(createdSubplebbit.description).to.equal(newSub.description);

        await createdSubplebbit.start();
        await new Promise((resolve) => createdSubplebbit.once("update", resolve));
        expect(createdSubplebbit.title).to.equal(newSub.title);
        expect(createdSubplebbit.description).to.equal(newSub.description);
        await createdSubplebbit.delete();
    });

    it(`Recreating a local running subplebbit should not stop it`, async () => {
        const sub = await createSubWithNoChallenge({}, plebbit);
        await sub.start();
        await new Promise((resolve) => sub.once("update", resolve));
        if (!sub.updatedAt) await new Promise((resolve) => sub.once("update", resolve));
        expect(sub.startedState).to.not.equal("stopped");

        const recreatedSub = (await plebbit.createSubplebbit({ address: sub.address })) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(recreatedSub.startedState).to.equal("stopped"); // startedState is only set by the actual instance, not synced across instances
        expect(sub.startedState).to.not.equal("stopped");
        await sub.stop();
    });

    itSkipIfRpc(`Can create a subplebbit if it's running in another Plebbit instance`, async () => {
        const firstPlebbit = await mockPlebbit();

        const sub = (await firstPlebbit.createSubplebbit({ address: signers[0].address })) as LocalSubplebbit | RpcLocalSubplebbit; // this sub is running in test-server process instance
        expect(sub.updatedAt).to.be.greaterThan(0);

        await firstPlebbit.destroy();
    });

    itSkipIfRpc(`Can create a subplebbit if it's running in the same plebbit instance`, async () => {
        const firstPlebbit = await mockPlebbit();
        const firstSub = (await firstPlebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        await firstSub.start();
        const differentPlebbit = await mockPlebbitV2({
            plebbitOptions: { dataPath: firstPlebbit.dataPath },
            stubStorage: false,
            mockResolve: true
        });

        const recreatedSub = (await differentPlebbit.createSubplebbit({ address: firstSub.address })) as
            | LocalSubplebbit
            | RpcLocalSubplebbit;
        expect(recreatedSub.startedState).to.equal("stopped");
        expect(recreatedSub.address).to.equal(firstSub.address);
        expect(recreatedSub.signer!.address).to.equal(firstSub.signer!.address);
        expect(recreatedSub.title).to.equal(firstSub.title);
        expect(recreatedSub.description).to.equal(firstSub.description);

        await firstPlebbit.destroy();
        await differentPlebbit.destroy();
    });

    it(`Fail to create a sub with ENS address has a capital letter`, async () => {
        try {
            await plebbit.createSubplebbit({ address: "testBso.bso" });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_DOMAIN_ADDRESS_HAS_CAPITAL_LETTER");
        }
    });

    it(`plebbit.createSubplebbit({address: undefined}) should throw a proper error if plebbit has no data path`, async () => {
        const plebbitWithNoDataPath = await mockPlebbitV2({ plebbitOptions: { dataPath: undefined } });
        expect(plebbitWithNoDataPath.dataPath).to.be.undefined;
        try {
            await plebbitWithNoDataPath.createSubplebbit({ address: undefined });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.be.oneOf([
                "ERR_INVALID_CREATE_REMOTE_SUBPLEBBIT_ARGS_SCHEMA",
                "ERR_INVALID_CREATE_SUBPLEBBIT_WITH_RPC_ARGS_SCHEMA"
            ]);
        }
    });

    it(`plebbit.subplebbits shows unlocked created subplebbits`, async () => {
        const title = "Test plebbit.subplebbits" + Date.now();
        const subSigner = await plebbit.createSigner();

        const createdSubplebbit = (await plebbit.createSubplebbit({ signer: subSigner, title: title })) as
            | LocalSubplebbit
            | RpcLocalSubplebbit;
        // At this point the sub should be unlocked and ready to be recreated by another instance
        const listedSubs = plebbit.subplebbits;
        expect(listedSubs).to.include(createdSubplebbit.address);

        expect(createdSubplebbit.address).to.equal(subSigner.address);
        expect(createdSubplebbit.title).to.equal(title);
    });
});

describe(`plebbit.createSubplebbit - performance regression`, async () => {
    let plebbit: PlebbitType;

    beforeAll(async () => {
        plebbit = await mockPlebbitV2();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`createSubplebbit({address}) for a stopped local subplebbit should not trigger IPNS resolution`, async () => {
        // Create a new local sub (it will NOT be started)
        const newSub = await plebbit.createSubplebbit();
        const address = newSub.address;

        // Now call createSubplebbit({address}) for the stopped sub.
        // Before the fix, this would await subplebbit.update() on the RPC server
        // which triggered IPNS resolution, taking 60+ seconds.
        const timeoutMs = 15000;
        const result = await Promise.race([
            plebbit.createSubplebbit({ address }).then((sub) => ({ sub, timedOut: false as const })),
            new Promise<{ sub: undefined; timedOut: true }>((resolve) =>
                setTimeout(() => resolve({ sub: undefined, timedOut: true }), timeoutMs)
            )
        ]);

        expect(result.timedOut, `createSubplebbit({address}) for stopped local sub took longer than ${timeoutMs}ms`).to.be.false;
        expect(result.sub!.address).to.equal(address);

        await newSub.delete();
    });

    it(`createSubplebbit({address}) over RPC for a stopped local subplebbit should not trigger IPNS resolution`, async () => {
        // This test creates its own RPC server to test the RPC-specific code path
        // The direct (non-RPC) case is covered by the test above
        const dataPath = tempy.directory();
        const rpcServerPort = 19170;

        const options: CreatePlebbitWsServerOptions = {
            port: rpcServerPort,
            plebbitOptions: {
                kuboRpcClientsOptions:
                    plebbit.kuboRpcClientsOptions as CreatePlebbitWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: plebbit.httpRoutersOptions,
                dataPath
            },
            startStartedSubplebbitsOnStartup: false
        };

        const rpcServer = await PlebbitWsServer.PlebbitWsServer(options);
        const rpcUrl = `ws://localhost:${rpcServerPort}`;
        const rpcPlebbit = await Plebbit({ plebbitRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

        // Create a sub (not started)
        const newSub = await rpcPlebbit.createSubplebbit({});
        const address = newSub.address;

        // Now call createSubplebbit({address}) — before the fix this took 60s
        const timeoutMs = 15000;
        const result = await Promise.race([
            rpcPlebbit.createSubplebbit({ address }).then((sub) => ({ sub, timedOut: false as const })),
            new Promise<{ sub: undefined; timedOut: true }>((resolve) =>
                setTimeout(() => resolve({ sub: undefined, timedOut: true }), timeoutMs)
            )
        ]);

        expect(result.timedOut, `createSubplebbit({address}) over RPC took longer than ${timeoutMs}ms`).to.be.false;
        expect(result.sub!.address).to.equal(address);

        await newSub.delete();
        await rpcPlebbit.destroy();
        await rpcServer.destroy();
    });
});

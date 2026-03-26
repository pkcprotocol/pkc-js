import { beforeAll, afterAll } from "vitest";
import {
    mockPlebbit,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    describeSkipIfRpc,
    mockPlebbitNoDataPathWithOnlyKuboClient
} from "../../../dist/node/test/test-util.js";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { PlebbitError } from "../../../dist/node/plebbit-error.js";

describeSkipIfRpc(`Local subplebbit emits errors properly in the publish loop`, async () => {
    let plebbit: PlebbitType;
    beforeAll(async () => {
        plebbit = await mockPlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`subplebbit.start() emits errors and recovers if the sync loop crashes once`, async () => {
        const sub = (await createSubWithNoChallenge({}, plebbit)) as LocalSubplebbit;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const errors: PlebbitError[] = [];
        sub.on("error", (err: PlebbitError | Error) => {
            errors.push(err as PlebbitError);
        });
        // @ts-expect-error _listenToIncomingRequests is private but we need to mock it for testing
        sub._listenToIncomingRequests = async () => {
            throw Error("Failed to load sub from db");
        };
        try {
            await publishRandomPost({ communityAddress: sub.address, plebbit: plebbit });
        } catch {}
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => errors.length >= 3, eventName: "error" });

        await sub.delete();

        expect(errors.length).to.be.greaterThan(0);
        for (const error of errors) {
            expect(error.message).to.equal("Failed to load sub from db");
        }
    });

    it(`subplebbit.start() emits errors if kubo API call  fails`, async () => {
        const sub = (await createSubWithNoChallenge({}, plebbit)) as LocalSubplebbit;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const errors: PlebbitError[] = [];
        sub.on("error", (err: PlebbitError | Error) => {
            errors.push(err as PlebbitError);
        });

        const ipfsClient = sub._clientsManager.getDefaultKuboRpcClient()!._client;

        const originalCp = ipfsClient.files.write.bind(ipfsClient.files);
        ipfsClient.files.write = () => {
            throw Error("Failed to copy a file");
        };
        await publishRandomPost({ communityAddress: sub.address, plebbit: plebbit });

        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => errors.length === 3, eventName: "error" });

        await sub.delete();
        ipfsClient.files.write = originalCp;
        expect(errors.length).to.be.greaterThan(0);

        for (const error of errors) {
            expect(error.message).to.equal("Failed to copy a file");
        }
    });

    it(`subplebbit.start can recover if pubsub.ls() fails`, async () => {
        const sub = (await createSubWithNoChallenge({}, plebbit)) as LocalSubplebbit | RpcLocalSubplebbit;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const errors: PlebbitError[] = [];
        sub.on("error", (err: PlebbitError | Error) => {
            errors.push(err as PlebbitError);
        });

        const pubsubClient = Object.values(plebbit.clients.pubsubKuboRpcClients)[0]._client;

        const originalPubsub = pubsubClient.pubsub.ls.bind(pubsubClient.pubsub);
        pubsubClient.pubsub.ls = () => {
            throw Error("Failed to ls pubsub topics");
        };

        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => errors.length === 3, eventName: "error" });

        pubsubClient.pubsub.ls = originalPubsub;

        const remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        await publishRandomPost({ communityAddress: sub.address, plebbit: remotePlebbit }); // pubsub topic is working
        await remotePlebbit.destroy();

        await sub.delete();
        expect(errors.length).to.be.greaterThan(0);

        for (const error of errors) {
            expect(error.message).to.equal("Failed to ls pubsub topics");
        }
    });
});

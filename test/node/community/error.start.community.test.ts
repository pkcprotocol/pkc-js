import { beforeAll, afterAll } from "vitest";
import {
    mockPKC,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    describeSkipIfRpc,
    mockPKCNoDataPathWithOnlyKuboClient
} from "../../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

describeSkipIfRpc(`Local community emits errors properly in the publish loop`, async () => {
    let pkc: PKCType;
    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`community.start() emits errors and recovers if the sync loop crashes once`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const errors: PKCError[] = [];
        community.on("error", (err: PKCError | Error) => {
            errors.push(err as PKCError);
        });
        // @ts-expect-error _listenToIncomingRequests is private but we need to mock it for testing
        community._listenToIncomingRequests = async () => {
            throw Error("Failed to load community from db");
        };
        try {
            await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        } catch {}
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => errors.length >= 3, eventName: "error" });

        await community.delete();

        expect(errors.length).to.be.greaterThan(0);
        for (const error of errors) {
            expect(error.message).to.equal("Failed to load community from db");
        }
    });

    it(`community.start() emits errors if kubo API call  fails`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const errors: PKCError[] = [];
        community.on("error", (err: PKCError | Error) => {
            errors.push(err as PKCError);
        });

        const ipfsClient = community._clientsManager.getDefaultKuboRpcClient()!._client;

        const originalCp = ipfsClient.files.write.bind(ipfsClient.files);
        ipfsClient.files.write = () => {
            throw Error("Failed to copy a file");
        };
        await publishRandomPost({ communityAddress: community.address, pkc: pkc });

        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => errors.length === 3, eventName: "error" });

        await community.delete();
        ipfsClient.files.write = originalCp;
        expect(errors.length).to.be.greaterThan(0);

        for (const error of errors) {
            expect(error.message).to.equal("Failed to copy a file");
        }
    });

    it(`community.start can recover if pubsub.ls() fails`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const errors: PKCError[] = [];
        community.on("error", (err: PKCError | Error) => {
            errors.push(err as PKCError);
        });

        const pubsubClient = Object.values(pkc.clients.pubsubKuboRpcClients)[0]._client;

        const originalPubsub = pubsubClient.pubsub.ls.bind(pubsubClient.pubsub);
        pubsubClient.pubsub.ls = () => {
            throw Error("Failed to ls pubsub topics");
        };

        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => errors.length === 3, eventName: "error" });

        pubsubClient.pubsub.ls = originalPubsub;

        const remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        await publishRandomPost({ communityAddress: community.address, pkc: remotePKC }); // pubsub topic is working
        await remotePKC.destroy();

        await community.delete();
        expect(errors.length).to.be.greaterThan(0);

        for (const error of errors) {
            expect(error.message).to.equal("Failed to ls pubsub topics");
        }
    });
});

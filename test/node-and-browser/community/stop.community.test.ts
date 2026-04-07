import signers from "../../fixtures/signers.js";

import {
    describeSkipIfRpc,
    getAvailablePKCConfigsToTestAgainst,
    isRpcFlagOn,
    mockRemotePKC,
    mockGatewayPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";

import { describe, it, afterAll } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

const communityAddress = signers[0].address;

function createAbortError(message: string) {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

function createBlockedNameResolver(key: string) {
    let receivedName: string | undefined;
    let receivedSignal: AbortSignal | undefined;
    let resolverCalled!: () => void;
    const waitUntilCalled = new Promise<void>((resolve) => {
        resolverCalled = resolve;
    });

    return {
        waitUntilCalled,
        getReceivedName: () => receivedName,
        getReceivedSignal: () => receivedSignal,
        resolver: {
            key,
            canResolve: () => true,
            provider: `${key}-provider`,
            resolve: async ({ name, abortSignal }: { name: string; provider: string; abortSignal?: AbortSignal }) => {
                receivedName = name;
                receivedSignal = abortSignal;
                resolverCalled();
                if (!abortSignal) throw new Error("Expected abortSignal to be passed to the resolver");
                await new Promise<never>((_, reject) => {
                    const rejectWithAbort = () =>
                        reject(abortSignal.reason instanceof Error ? abortSignal.reason : createAbortError("The operation was aborted"));

                    if (abortSignal.aborted) {
                        rejectWithAbort();
                        return;
                    }

                    abortSignal.addEventListener("abort", rejectWithAbort, { once: true });
                });
                throw new Error("Blocked resolver should only finish by aborting");
            }
        }
    };
}

getAvailablePKCConfigsToTestAgainst()
    .filter((config) => isRpcFlagOn() || config.testConfigCode !== "remote-pkc-rpc")
    .map((config) =>
        describe(`community.stop() timing - Remote - ${config.name}`, async () => {
            let pkc: PKCType;

            afterAll(async () => {
                await pkc.destroy();
            });

            it(`Remote community stop() after update() should complete within 10s`, async () => {
                pkc = await config.pkcInstancePromise();
                const sub = (await pkc.createCommunity({ address: communityAddress })) as RemoteCommunity;
                await sub.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => typeof sub.updatedAt === "number"
                });
                const startMs = Date.now();
                await sub.stop();
                const elapsed = Date.now() - startMs;
                expect(elapsed).to.be.lessThan(10000);
            });
        })
    );

describe(`community.stop() idempotency`, async () => {
    it(`community.stop() should be a no-op when state is already "stopped"`, async () => {
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        const sub = await pkc.createCommunity({ address: communityAddress });
        expect(sub.state).to.equal("stopped");
        await sub.stop(); // should not throw
        expect(sub.state).to.equal("stopped");
        await pkc.destroy();
    });
});

describeSkipIfRpc(`community.stop() aborts verification`, async () => {
    it(`community.stop() aborts community-name resolution without emitting a failure`, async () => {
        const blockedResolver = createBlockedNameResolver("sub-blocked-resolver");
        const pkc = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: { nameResolvers: [blockedResolver.resolver] }
        });

        try {
            const sub = await pkc.createCommunity({ address: "blocked-sub.bso" });
            const errors: Error[] = [];
            sub.on("error", (error) => errors.push(error as Error));

            await sub.update();
            await blockedResolver.waitUntilCalled;

            expect(blockedResolver.getReceivedName()).to.equal("blocked-sub.bso");
            expect(sub.clients.nameResolvers["sub-blocked-resolver"].state).to.equal("resolving-community-name");

            await sub.stop();

            expect(sub.state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
            expect(sub.clients.nameResolvers["sub-blocked-resolver"].state).to.equal("stopped");
            expect(blockedResolver.getReceivedSignal()!.aborted).to.equal(true);
            expect(sub.updatedAt).to.be.undefined;
            expect(sub.raw.communityIpfs).to.be.undefined;
            expect(errors).to.have.length(0);
        } finally {
            await pkc.destroy();
        }
    });
});

describeSkipIfRpc(`community.stop() aborts in-flight gateway fetches`, async () => {
    it(`community.stop() aborts gateway fetch of community IPNS`, async () => {
        // Use a non-routable IP that will hang forever
        const pkc = await mockGatewayPKC({
            pkcOptions: {
                ipfsGatewayUrls: ["http://192.0.2.1:1"]
            }
        });

        try {
            const sub = await pkc.createCommunity({ address: communityAddress });
            const errors: Error[] = [];
            sub.on("error", (error) => errors.push(error as Error));

            await sub.update();

            // Wait until the gateway client is actively fetching
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => sub.clients.ipfsGateways["http://192.0.2.1:1"]?.state === "fetching-ipns"
            });

            const startMs = Date.now();
            await sub.stop();
            const elapsed = Date.now() - startMs;

            expect(sub.state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
            expect(sub.clients.ipfsGateways["http://192.0.2.1:1"].state).to.equal("stopped");
            expect(elapsed).to.be.lessThan(2000);
        } finally {
            await pkc.destroy();
        }
    });

    it(`community.stop() aborts P2P IPNS resolve via kubo`, async () => {
        // Use kubo with a non-existent IPNS name that will hang during resolve
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();

        try {
            // Use a valid but non-existent IPNS name
            const sub = await pkc.createCommunity({ address: "12D3KooWHFMSoRMak4VCKwTrURP1Rf2JHNGbAGCqU4jJhAPZjR3j" });
            const errors: Error[] = [];
            sub.on("error", (error) => errors.push(error as Error));

            await sub.update();

            const kuboUrl = Object.keys(pkc.clients.kuboRpcClients)[0];
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => (sub as RemoteCommunity).clients.kuboRpcClients[kuboUrl]?.state === "fetching-ipns"
            });

            const startMs = Date.now();
            await sub.stop();
            const elapsed = Date.now() - startMs;

            expect(sub.state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
            expect(elapsed).to.be.lessThan(5000);
        } finally {
            await pkc.destroy();
        }
    });

    it(`community.stop() interrupts the inter-update sleep`, async () => {
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();

        try {
            const sub = (await pkc.createCommunity({ address: communityAddress })) as RemoteCommunity;
            await sub.update();

            // Wait for first successful update
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });

            // Now sub is in the sleep phase between updates
            const startMs = Date.now();
            await sub.stop();
            const elapsed = Date.now() - startMs;

            expect(sub.state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
            // Should not wait for the full updateInterval (which is 1000ms for kubo)
            expect(elapsed).to.be.lessThan(1000);
        } finally {
            await pkc.destroy();
        }
    });
});

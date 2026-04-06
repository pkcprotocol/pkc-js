import signers from "../../fixtures/signers.js";

import {
    describeSkipIfRpc,
    getAvailablePlebbitConfigsToTestAgainst,
    isRpcFlagOn,
    mockRemotePlebbit,
    mockGatewayPlebbit,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";

import { describe, it, afterAll } from "vitest";

import type { Plebbit as PlebbitType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteSubplebbit } from "../../../dist/node/community/remote-community.js";

const subplebbitAddress = signers[0].address;

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

getAvailablePlebbitConfigsToTestAgainst()
    .filter((config) => isRpcFlagOn() || config.testConfigCode !== "remote-plebbit-rpc")
    .map((config) =>
        describe(`subplebbit.stop() timing - Remote - ${config.name}`, async () => {
            let plebbit: PlebbitType;

            afterAll(async () => {
                await plebbit.destroy();
            });

            it(`Remote subplebbit stop() after update() should complete within 10s`, async () => {
                plebbit = await config.plebbitInstancePromise();
                const sub = (await plebbit.createSubplebbit({ address: subplebbitAddress })) as RemoteSubplebbit;
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

describe(`subplebbit.stop() idempotency`, async () => {
    it(`subplebbit.stop() should be a no-op when state is already "stopped"`, async () => {
        const plebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
        expect(sub.state).to.equal("stopped");
        await sub.stop(); // should not throw
        expect(sub.state).to.equal("stopped");
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`subplebbit.stop() aborts verification`, async () => {
    it(`subplebbit.stop() aborts community-name resolution without emitting a failure`, async () => {
        const blockedResolver = createBlockedNameResolver("sub-blocked-resolver");
        const plebbit = await mockRemotePlebbit({
            mockResolve: false,
            plebbitOptions: { nameResolvers: [blockedResolver.resolver] }
        });

        try {
            const sub = await plebbit.createSubplebbit({ address: "blocked-sub.bso" });
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
            expect(sub.raw.subplebbitIpfs).to.be.undefined;
            expect(errors).to.have.length(0);
        } finally {
            await plebbit.destroy();
        }
    });
});

describeSkipIfRpc(`subplebbit.stop() aborts in-flight gateway fetches`, async () => {
    it(`subplebbit.stop() aborts gateway fetch of subplebbit IPNS`, async () => {
        // Use a non-routable IP that will hang forever
        const plebbit = await mockGatewayPlebbit({
            plebbitOptions: {
                ipfsGatewayUrls: ["http://192.0.2.1:1"]
            }
        });

        try {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
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
            await plebbit.destroy();
        }
    });

    it(`subplebbit.stop() aborts P2P IPNS resolve via kubo`, async () => {
        // Use kubo with a non-existent IPNS name that will hang during resolve
        const plebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();

        try {
            // Use a valid but non-existent IPNS name
            const sub = await plebbit.createSubplebbit({ address: "12D3KooWHFMSoRMak4VCKwTrURP1Rf2JHNGbAGCqU4jJhAPZjR3j" });
            const errors: Error[] = [];
            sub.on("error", (error) => errors.push(error as Error));

            await sub.update();

            const kuboUrl = Object.keys(plebbit.clients.kuboRpcClients)[0];
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => (sub as RemoteSubplebbit).clients.kuboRpcClients[kuboUrl]?.state === "fetching-ipns"
            });

            const startMs = Date.now();
            await sub.stop();
            const elapsed = Date.now() - startMs;

            expect(sub.state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
            expect(elapsed).to.be.lessThan(5000);
        } finally {
            await plebbit.destroy();
        }
    });

    it(`subplebbit.stop() interrupts the inter-update sleep`, async () => {
        const plebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();

        try {
            const sub = (await plebbit.createSubplebbit({ address: subplebbitAddress })) as RemoteSubplebbit;
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
            await plebbit.destroy();
        }
    });
});

import { describeSkipIfRpc, mockPKCV2 } from "../../dist/node/test/test-util.js";

function createAbortError(message: string) {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

describeSkipIfRpc(`nameResolver abortSignal support`, async () => {
    it(`Resolver receives abortSignal, rejects with AbortError, and resets resolver state`, async () => {
        let receivedSignal: AbortSignal | undefined;
        let resolverCalled!: () => void;
        const waitUntilResolverCalled = new Promise<void>((resolve) => {
            resolverCalled = resolve;
        });

        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    {
                        key: "signal-resolver",
                        canResolve: () => true,
                        provider: "signal-provider",
                        resolve: async ({ abortSignal }: { name: string; provider: string; abortSignal?: AbortSignal }) => {
                            receivedSignal = abortSignal;
                            resolverCalled();
                            if (!abortSignal) throw new Error("Expected abortSignal to be passed to the resolver");
                            await new Promise<never>((_, reject) => {
                                const rejectWithAbort = () =>
                                    reject(
                                        abortSignal.reason instanceof Error
                                            ? abortSignal.reason
                                            : createAbortError("The operation was aborted")
                                    );

                                if (abortSignal.aborted) {
                                    rejectWithAbort();
                                    return;
                                }

                                abortSignal.addEventListener("abort", rejectWithAbort, { once: true });
                            });
                            throw new Error("Resolver should only finish after it is aborted");
                        }
                    }
                ]
            }
        });

        try {
            const abortController = new AbortController();
            const resolutionPromise = pkc._clientsManager.resolveCommunityNameIfNeeded({
                communityName: "test.bso",
                abortSignal: abortController.signal
            });

            await waitUntilResolverCalled;

            expect(receivedSignal).to.equal(abortController.signal);
            expect(pkc._clientsManager.clients.nameResolvers["signal-resolver"].state).to.equal("resolving-community-name");

            abortController.abort(createAbortError("Resolver aborted"));

            await expect(resolutionPromise).rejects.toMatchObject({ name: "AbortError", message: "Resolver aborted" });
            expect(pkc._clientsManager.clients.nameResolvers["signal-resolver"].state).to.equal("stopped");
        } finally {
            await pkc.destroy();
        }
    });
});

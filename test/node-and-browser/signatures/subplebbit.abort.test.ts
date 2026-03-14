import signers from "../../fixtures/signers.js";
import { describeSkipIfRpc, mockPlebbitV2 } from "../../../dist/node/test/test-util.js";
import { verifySubplebbit } from "../../../dist/node/signer/signatures.js";
import type { SubplebbitIpfsType } from "../../../dist/node/subplebbit/types.js";
import validSubplebbitFixture from "../../fixtures/signatures/subplebbit/valid_subplebbit_ipfs.json" with { type: "json" };
import { sha256 } from "js-sha256";
import * as remeda from "remeda";

function createAbortError(message: string) {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

describeSkipIfRpc(`verifySubplebbit abort propagation`, async () => {
    it(`verifySubplebbit propagates abortSignal into nested comment author resolution`, async () => {
        let receivedSignal: AbortSignal | undefined;
        let receivedName: string | undefined;
        let resolverCalled!: () => void;
        const waitUntilResolverCalled = new Promise<void>((resolve) => {
            resolverCalled = resolve;
        });

        const tempPlebbit = await mockPlebbitV2({
            stubStorage: false,
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "nested-author-resolver",
                        canResolve: () => true,
                        provider: "nested-author-provider",
                        resolve: async ({ name, abortSignal }: { name: string; provider: string; abortSignal?: AbortSignal }) => {
                            receivedName = name;
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
            const sub = remeda.clone(validSubplebbitFixture) as SubplebbitIpfsType;
            const pageCommentWithDomainAuthor = Object.values(sub.posts?.pages || {})
                .flatMap((page) => page?.comments || [])
                .find((pageComment) => {
                    const authorAddress = pageComment.comment.author.address;
                    return typeof authorAddress === "string" && authorAddress.includes(".");
                });

            expect(pageCommentWithDomainAuthor).to.not.be.undefined;
            const authorAddress = pageCommentWithDomainAuthor!.comment.author.address as string;
            const abortController = new AbortController();
            const cacheKey = sha256(authorAddress + pageCommentWithDomainAuthor!.comment.signature.publicKey);

            const verificationPromise = verifySubplebbit({
                subplebbit: sub,
                subplebbitIpnsName: signers[0].address,
                resolveAuthorNames: tempPlebbit.resolveAuthorNames,
                clientsManager: tempPlebbit._clientsManager,
                validatePages: true,
                cacheIfValid: false,
                abortSignal: abortController.signal
            });

            await waitUntilResolverCalled;

            expect(receivedName).to.equal(authorAddress);
            expect(receivedSignal).to.equal(abortController.signal);
            expect(tempPlebbit._clientsManager.clients.nameResolvers["nested-author-resolver"].state).to.equal("resolving-author-name");

            abortController.abort(createAbortError("Aborted nested author resolution"));

            await expect(verificationPromise).rejects.toMatchObject({
                name: "AbortError",
                message: "Aborted nested author resolution"
            });
            expect(tempPlebbit._clientsManager.clients.nameResolvers["nested-author-resolver"].state).to.equal("stopped");
            expect(tempPlebbit._memCaches.nameResolvedCache.get(cacheKey)).to.be.undefined;
        } finally {
            await tempPlebbit.destroy();
        }
    });
});

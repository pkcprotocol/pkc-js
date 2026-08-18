import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, generateMockPost } from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// stop() and destroy() used to be unable to cancel a community fetch that was already in flight, so
// publishing against a community whose IPNS record never resolves kept the caller blocked for the
// whole _timeouts["community-ipns"] (5 minutes by default) after they had already stopped it.
// Issue #275.
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`publication.stop() aborts the in-flight community fetch - ${config.name}`, () => {
        let pkc: PKCType;
        let unresolvableCommunityAddress: string;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            // A signer whose key was never imported into any IPNS node: nothing ever resolves for it.
            unresolvableCommunityAddress = (await pkc.createSigner()).address;
        });

        afterAll(async () => {
            if (!pkc.destroyed) await pkc.destroy();
        });

        it("unwinds publish() well before the community-ipns timeout", async () => {
            const post = await generateMockPost({ communityAddress: unresolvableCommunityAddress, pkc });
            post.on("error", () => {});

            const publishOutcome = post.publish().then(
                (): PKCError | undefined => undefined,
                (e): PKCError | undefined => e as PKCError
            );
            // Only stop once the fetch is actually in flight, otherwise we would be testing the
            // already-aborted path instead of cancellation.
            await vi.waitFor(() => expect(post.publishingState).to.be.oneOf(["resolving-community-name", "fetching-community-ipns"]), {
                timeout: 30000,
                interval: 50
            });

            const stoppedAt = Date.now();
            await post.stop();
            const error = await publishOutcome;

            expect(error?.code).to.equal("ERR_GET_COMMUNITY_ABORTED");
            expect(Date.now() - stoppedAt).to.be.lessThan(30000);
            expect(pkc._updatingCommunities.size()).to.equal(0);
            expect(pkc._publishingPublications.has(post)).to.be.false;
        });

        it("unwinds publish() when the pkc is destroyed mid-fetch", async () => {
            const localPKC = await config.pkcInstancePromise();
            const post = await generateMockPost({ communityAddress: (await localPKC.createSigner()).address, pkc: localPKC });
            post.on("error", () => {});

            const publishOutcome = post.publish().then(
                (): PKCError | undefined => undefined,
                (e): PKCError | undefined => e as PKCError
            );
            await vi.waitFor(() => expect(post.publishingState).to.be.oneOf(["resolving-community-name", "fetching-community-ipns"]), {
                timeout: 30000,
                interval: 50
            });

            const destroyedAt = Date.now();
            await localPKC.destroy();
            const error = await publishOutcome;

            expect(error).to.be.an("Error");
            expect(Date.now() - destroyedAt).to.be.lessThan(30000);
        });
    });
});

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// pkc.getCommunity() on a community whose IPNS record never resolves blocks for the whole
// _timeouts["community-ipns"] (5 minutes by default). These tests pin that an abortSignal unwinds it
// immediately, reports it distinctly from a timeout, and leaves no community instance running
// behind (issue #275).
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`pkc.getCommunity abortSignal - ${config.name}`, () => {
        let pkc: PKCType;
        let unresolvableCommunityAddress: string;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            // A signer whose key was never imported into any IPNS node, so nothing ever resolves for
            // it and getCommunity() keeps retrying until the community-ipns timeout.
            unresolvableCommunityAddress = (await pkc.createSigner()).address;
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it("rejects with ERR_GET_COMMUNITY_ABORTED when the signal fires mid-fetch", async () => {
            const abortController = new AbortController();
            const startedAt = Date.now();
            const getCommunityPromise = pkc.getCommunity(
                { address: unresolvableCommunityAddress },
                { abortSignal: abortController.signal }
            );
            const timer = setTimeout(() => abortController.abort(), 1000);

            const error = await getCommunityPromise.then(
                (): PKCError | undefined => undefined,
                (e): PKCError | undefined => e as PKCError
            );
            clearTimeout(timer);

            expect(error).to.be.an("Error");
            expect(error?.code).to.equal("ERR_GET_COMMUNITY_ABORTED");
            // The point of the signal: we come back on abort, not on the timeout.
            expect(Date.now() - startedAt).to.be.lessThan(30000);
        });

        it("rejects immediately when the signal is already aborted", async () => {
            const startedAt = Date.now();
            const error = await pkc.getCommunity({ address: unresolvableCommunityAddress }, { abortSignal: AbortSignal.abort() }).then(
                (): PKCError | undefined => undefined,
                (e): PKCError | undefined => e as PKCError
            );

            expect(error?.code).to.equal("ERR_GET_COMMUNITY_ABORTED");
            expect(Date.now() - startedAt).to.be.lessThan(30000);
            expect(pkc._updatingCommunities.size()).to.equal(0);
        });

        it("stops the community instance it created when aborted", async () => {
            const abortController = new AbortController();
            const getCommunityPromise = pkc.getCommunity(
                { address: unresolvableCommunityAddress },
                { abortSignal: abortController.signal }
            );
            const timer = setTimeout(() => abortController.abort(), 1000);
            await getCommunityPromise.catch(() => {});
            clearTimeout(timer);

            // getCommunity() owns the instance it created, so abort has to leave the registry as
            // empty as a successful one-shot fetch would.
            expect(pkc._updatingCommunities.size()).to.equal(0);
        });

        it("does not stop a community instance that somebody else is updating", async () => {
            // getCommunity() attaches to the already-updating instance rather than resolving IPNS
            // itself, so an unconditional stop() on abort would tear down a community the caller
            // below is still using.
            const community = <RemoteCommunity>await pkc.createCommunity({ address: unresolvableCommunityAddress });
            community.on("error", () => {});
            await community.update();
            expect(pkc._updatingCommunities.size()).to.equal(1);

            try {
                const abortController = new AbortController();
                const getCommunityPromise = pkc.getCommunity(
                    { address: unresolvableCommunityAddress },
                    { abortSignal: abortController.signal }
                );
                const timer = setTimeout(() => abortController.abort(), 1000);
                const error = await getCommunityPromise.then(
                    (): PKCError | undefined => undefined,
                    (e): PKCError | undefined => e as PKCError
                );
                clearTimeout(timer);

                expect(error?.code).to.equal("ERR_GET_COMMUNITY_ABORTED");
                expect(community.state).to.equal("updating");
                expect(pkc._updatingCommunities.size()).to.equal(1);
            } finally {
                await community.stop();
            }
        });
    });
});

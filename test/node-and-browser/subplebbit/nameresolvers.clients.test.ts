import signers from "../../fixtures/signers.js";

import {
    createMockNameResolver,
    processAllCommentsRecursively,
    publishRandomPost,
    mockPlebbitV2,
    waitTillPostInSubplebbitPages
} from "../../../dist/node/test/test-util.js";
import { describe, it } from "vitest";

const subplebbitAddress = signers[9].address;

async function createRemotePlebbitWithMockResolver({
    records = new Map<string, string | undefined>(),
    stubStorage = true,
    validatePages = false
}: {
    records?: Map<string, string | undefined>;
    stubStorage?: boolean;
    validatePages?: boolean;
} = {}) {
    const plebbit = await mockPlebbitV2({
        stubStorage,
        remotePlebbit: true,
        mockResolve: false,
        plebbitOptions: {
            validatePages,
            nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records })]
        }
    });

    return { plebbit, records };
}

describe(`subplebbit.clients.nameResolvers`, async () => {
    it(`subplebbit.clients.nameResolvers[resolverKey].state is stopped by default`, async () => {
        const { plebbit } = await createRemotePlebbitWithMockResolver();
        const mockSub = await plebbit.getSubplebbit({ address: subplebbitAddress });
        expect(Object.keys(mockSub.clients.nameResolvers).length).to.be.greaterThanOrEqual(1);
        for (const resolverKey of Object.keys(mockSub.clients.nameResolvers))
            expect(mockSub.clients.nameResolvers[resolverKey].state).to.equal("stopped");
        await plebbit.destroy();
    });

    it(`Correct order of nameResolvers state when sub pages has comments with author.address as domain - uncached`, async () => {
        // These tests can't work with RPC clients because:
        // - RPC clients have empty clients.nameResolvers (nameResolvers contain functions that can't be serialized over RPC, see plebbit.ts)
        // - The RPC server resolves names server-side and doesn't transmit resolver state changes to the client
        // - Until the RPC protocol is extended to relay nameResolver state changes, these tests only exercise the non-RPC path
        const plebbit = await mockPlebbitV2({ stubStorage: true, plebbitOptions: { validatePages: false }, remotePlebbit: true }); // no storage so it wouldn't be cached

        const mockPost = await publishRandomPost({
            communityAddress: subplebbitAddress,
            plebbit: plebbit,
            postProps: {
                author: { address: "plebbit.bso" },
                signer: signers[3]
            }
        });

        await waitTillPostInSubplebbitPages(mockPost as Required<Pick<typeof mockPost, "cid"> & { communityAddress: string }>, plebbit);

        const { plebbit: differentPlebbit } = await createRemotePlebbitWithMockResolver({
            stubStorage: true,
            validatePages: true
        });
        const sub = await differentPlebbit.createSubplebbit({ address: mockPost.communityAddress });

        const recordedStates: string[] = [];
        const resolverKey = Object.keys(sub.clients.nameResolvers)[0];
        sub.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => recordedStates.push(newState));

        const updatePromise = new Promise((resolve) => sub.once("update", resolve));

        await sub.update();

        await updatePromise;
        await sub.stop();

        const commentsWithDomainAuthor: { author: { address: string } }[] = [];
        processAllCommentsRecursively(
            sub.posts.pages.hot.comments,
            (comment) => comment.author.address.includes(".") && commentsWithDomainAuthor.push(comment)
        );

        expect(commentsWithDomainAuthor.length).to.be.greaterThan(0);
        expect(recordedStates.length).to.equal(commentsWithDomainAuthor.length * 2);
        expect(recordedStates).to.deep.equal(Array(commentsWithDomainAuthor.length).fill(["resolving-author-name", "stopped"]).flat());
        await differentPlebbit.destroy();
    });

    it(`Correct order of nameResolvers state when updating a subplebbit that was created with plebbit.createSubplebbit({address}) - uncached`, async () => {
        const { plebbit: remotePlebbit } = await createRemotePlebbitWithMockResolver({
            stubStorage: true
        });
        const sub = await remotePlebbit.createSubplebbit({ address: "plebbit.bso" });

        const expectedStates = ["resolving-community-name", "stopped"];

        const recordedStates: string[] = [];

        const resolverKey = Object.keys(sub.clients.nameResolvers)[0];
        sub.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => recordedStates.push(newState));

        const updatePromise = new Promise((resolve) => sub.once("update", resolve));
        await sub.update();

        await updatePromise;

        await sub.stop();

        expect(recordedStates.slice(0, 2)).to.deep.equal(expectedStates);
        await remotePlebbit.destroy();
    });
});

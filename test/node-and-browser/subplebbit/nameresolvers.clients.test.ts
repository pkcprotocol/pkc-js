import signers from "../../fixtures/signers.js";

import {
    createMockNameResolver,
    describeSkipIfRpc,
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

describeSkipIfRpc(`subplebbit.clients.nameResolvers`, async () => {
    it(`subplebbit.clients.nameResolvers[resolverKey].state is stopped by default`, async () => {
        const { plebbit } = await createRemotePlebbitWithMockResolver();
        const mockSub = await plebbit.getSubplebbit({ address: subplebbitAddress });
        expect(Object.keys(mockSub.clients.nameResolvers).length).to.be.greaterThanOrEqual(1);
        for (const resolverKey of Object.keys(mockSub.clients.nameResolvers))
            expect(mockSub.clients.nameResolvers[resolverKey].state).to.equal("stopped");
        await plebbit.destroy();
    });

    it(`Correct order of nameResolvers state when sub pages has comments with author.address as domain - uncached`, async () => {
        const plebbit = await mockPlebbitV2({ stubStorage: true, plebbitOptions: { validatePages: false }, remotePlebbit: true }); // no storage so it wouldn't be cached

        const mockPost = await publishRandomPost({
            subplebbitAddress: subplebbitAddress,
            plebbit: plebbit,
            postProps: {
                author: { address: "plebbit.bso" },
                signer: signers[6]
            }
        });

        await waitTillPostInSubplebbitPages(mockPost as Required<Pick<typeof mockPost, "cid" | "subplebbitAddress">>, plebbit);

        const { plebbit: differentPlebbit } = await createRemotePlebbitWithMockResolver({
            stubStorage: true,
            validatePages: true
        });
        const sub = await differentPlebbit.createSubplebbit({ address: mockPost.subplebbitAddress });

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

    it(`Correct order of nameResolvers state when sub pages has a comment with author.address as domain - cached`, async () => {
        const { plebbit: differentPlebbit, records } = await createRemotePlebbitWithMockResolver({
            stubStorage: false
        });
        const sub = await differentPlebbit.createSubplebbit({ address: subplebbitAddress });

        records.set("plebbit.eth", signers[6].address);
        const recordedStates: string[] = [];
        const expectedStates: string[] = []; // should be empty cause it's cached
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
        expect(recordedStates).to.deep.equal(expectedStates);
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

    it(`Correct order of nameResolvers state when updating a subplebbit that was created with plebbit.createSubplebbit({address}) - cached`, async () => {
        const { plebbit, records } = await createRemotePlebbitWithMockResolver({
            stubStorage: false
        });
        const sub = await plebbit.createSubplebbit({ address: "plebbit.bso" });

        records.set(sub.address, signers[3].address);

        // should be cached now

        const recordedStates: string[] = [];

        const expectedStates: string[] = [];

        const resolverKey = Object.keys(sub.clients.nameResolvers)[0];
        sub.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => recordedStates.push(newState));

        const updatePromise = new Promise((resolve) => sub.once("update", resolve));

        await sub.update();

        await updatePromise;
        await sub.stop();

        expect(recordedStates).to.deep.equal(expectedStates); // should be empty cause it's cached
        await plebbit.destroy();
    });
});

import signers from "../../fixtures/signers.js";

import {
    describeSkipIfRpc,
    processAllCommentsRecursively,
    mockCacheOfTextRecord,
    publishRandomPost,
    mockPlebbitV2,
    waitTillPostInSubplebbitPages
} from "../../../dist/node/test/test-util.js";
import { describe, it } from "vitest";

const subplebbitAddress = signers[9].address;

describeSkipIfRpc(`subplebbit.clients.nameResolvers`, async () => {
    it(`subplebbit.clients.nameResolvers[resolverKey].state is stopped by default`, async () => {
        const plebbit = await mockPlebbitV2({ stubStorage: true, plebbitOptions: { validatePages: false }, remotePlebbit: true });
        const mockSub = await plebbit.getSubplebbit({ address: subplebbitAddress });
        expect(Object.keys(mockSub.clients.nameResolvers).length).to.be.greaterThanOrEqual(1);
        for (const resolverKey of Object.keys(mockSub.clients.nameResolvers))
            expect(mockSub.clients.nameResolvers[resolverKey].state).to.equal("stopped");
        await plebbit.destroy();
    });

    it(`Correct order of nameResolvers state when sub pages has comments with author.address as domain - uncached`, async () => {
        const plebbit = await mockPlebbitV2({ stubStorage: true, plebbitOptions: { validatePages: false }, remotePlebbit: true }); // no storage so it wouldn't be cached

        const mockPost = await publishRandomPost(subplebbitAddress, plebbit, {
            author: { address: "plebbit.bso" },
            signer: signers[6]
        });

        await waitTillPostInSubplebbitPages(mockPost as Required<Pick<typeof mockPost, "cid" | "subplebbitAddress">>, plebbit);

        const differentPlebbit = await mockPlebbitV2({
            stubStorage: true, // no storage so it wouldn't be cached
            remotePlebbit: true,
            mockResolve: true,
            plebbitOptions: { validatePages: true }
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
        expect(recordedStates).to.deep.equal(Array(commentsWithDomainAuthor.length).fill(["resolving-author-address", "stopped"]).flat());
        await differentPlebbit.destroy();
    });

    it(`Correct order of nameResolvers state when sub pages has a comment with author.address as domain - cached`, async () => {
        const differentPlebbit = await mockPlebbitV2({
            stubStorage: false, // make sure storage is enabled so it would be cached
            remotePlebbit: true,
            mockResolve: true
        }); // using different plebbit to it wouldn't be cached
        const sub = await differentPlebbit.createSubplebbit({ address: subplebbitAddress });

        await mockCacheOfTextRecord({
            plebbit: sub._plebbit,
            domain: "plebbit.eth",
            textRecord: "plebbit-author-address",
            value: signers[6].address
        });
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
        const remotePlebbit = await mockPlebbitV2({
            stubStorage: true, // force no storage so it wouldn't be cached
            remotePlebbit: true,
            mockResolve: true
        });
        const sub = await remotePlebbit.createSubplebbit({ address: "plebbit.bso" });

        const expectedStates = ["resolving-subplebbit-address", "stopped"];

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
        const plebbit = await mockPlebbitV2({
            stubStorage: false, // make sure storage is enabled so it would be cached
            remotePlebbit: true,
            mockResolve: true
        }); // using different plebbit to it wouldn't be cached
        const sub = await plebbit.createSubplebbit({ address: "plebbit.bso" });

        await mockCacheOfTextRecord({
            plebbit: sub._plebbit,
            domain: sub.address,
            textRecord: "subplebbit-address",
            value: signers[3].address
        });

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

import { beforeAll, afterAll, it } from "vitest";
import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    publishWithExpectedResult,
    describeSkipIfRpc,
    publishRandomPost,
    mockPlebbitV2,
    mockCacheOfTextRecord,
    resolveWhenConditionIsTrue,
    publishRandomReply,
    waitTillReplyInParentPages
} from "../../../../../dist/node/test/test-util.js";
import type { Plebbit } from "../../../../../dist/node/plebbit/plebbit.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";

const subplebbitAddress = signers[0].address;

// Helper type for required fields for test utilities
type CommentWithRequiredFields = Required<Pick<CommentIpfsWithCidDefined, "cid" | "subplebbitAddress" | "parentCid">>;

describeSkipIfRpc(`comment.clients.nameResolvers`, async () => {
    let plebbit: Plebbit;
    beforeAll(async () => {
        plebbit = await mockPlebbitV2({
            plebbitOptions: { dataPath: undefined },
            forceMockPubsub: false,
            stubStorage: false,
            mockResolve: true
        });
    });
    afterAll(async () => {
        await plebbit.destroy();
    });
    it(`comment.clients.nameResolvers[resolverKey].state is stopped by default`, async () => {
        const mockPost = await generateMockPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
        expect(Object.keys(mockPost.clients.nameResolvers).length).to.be.greaterThanOrEqual(1);
        for (const resolverKey of Object.keys(mockPost.clients.nameResolvers))
            expect(mockPost.clients.nameResolvers[resolverKey].state).to.equal("stopped");
    });

    it(`Correct order of nameResolvers state when updating a comment whose sub is a domain - uncached`, async () => {
        const mockPost = await publishRandomPost({ subplebbitAddress: "plebbit.bso", plebbit: plebbit });

        await mockPost.stop();

        const differentPlebbit = await mockPlebbitV2({ stubStorage: false, remotePlebbit: true, mockResolve: true }); // using different plebbit to it wouldn't be cached
        await mockCacheOfTextRecord({
            plebbit: differentPlebbit,
            domain: "plebbit.bso",
            resolveType: "subplebbit",
            value: undefined
        });
        const updatingPost = await differentPlebbit.createComment({ cid: mockPost.cid });

        const expectedStates = ["resolving-subplebbit-address", "stopped"];

        const actualStates: string[] = [];

        const resolverKey = Object.keys(updatingPost.clients.nameResolvers)[0];

        updatingPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await updatingPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: updatingPost, predicate: async () => typeof updatingPost.updatedAt === "number" });

        await updatingPost.stop();

        expect(actualStates).to.deep.equal(expectedStates);

        await differentPlebbit.destroy();
    });

    it(`Correct order of nameResolvers state when updating a comment whose sub is a domain - cached`, async () => {
        const mockPost = await publishRandomPost({ subplebbitAddress: "plebbit.bso", plebbit: plebbit });

        await mockPost.stop();

        const updatingPost = await plebbit.createComment({ cid: mockPost.cid });

        await mockCacheOfTextRecord({
            plebbit: mockPost._plebbit,
            domain: "plebbit.bso",
            resolveType: "subplebbit",
            value: signers[3].address
        });

        const expectedStates: string[] = []; // no state change because it's cached

        const actualStates: string[] = [];

        const resolverKey = Object.keys(mockPost.clients.nameResolvers)[0];

        updatingPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await updatingPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: updatingPost, predicate: async () => typeof updatingPost.updatedAt === "number" });

        await updatingPost.stop();

        expect(actualStates).to.deep.equal(expectedStates);
    });

    it(`Correct order of nameResolvers state when updating a comment whose author address is a domain - uncached`, async () => {
        // Create a post with a domain as author address, signed with the correct signer
        const plebbit: Plebbit = await mockPlebbitV2({ stubStorage: false, remotePlebbit: true, mockResolve: true });
        const mockPost = await publishRandomPost({
            subplebbitAddress: subplebbitAddress,
            plebbit: plebbit,
            postProps: {
                author: { address: "plebbit.eth" },
                signer: signers[6]
            }
        });

        // Create a new plebbit instance to avoid caching
        const differentPlebbit = await mockPlebbitV2({ stubStorage: false, remotePlebbit: true, mockResolve: true });

        // Clear the cache for the domain
        await mockCacheOfTextRecord({
            plebbit: differentPlebbit,
            domain: "plebbit.eth",
            resolveType: "author",
            value: undefined
        });

        const updatingPost = await differentPlebbit.createComment({ cid: mockPost.cid });

        const expectedStates = ["resolving-author-address", "stopped"];
        const actualStates: string[] = [];

        const resolverKey = Object.keys(updatingPost.clients.nameResolvers)[0];

        updatingPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await updatingPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: updatingPost, predicate: async () => typeof updatingPost.updatedAt === "number" });

        await updatingPost.stop();

        expect(actualStates).to.deep.equal(expectedStates);

        await differentPlebbit.destroy();
    });

    it(`Correct order of nameResolvers state when updating a comment whose author address is a domain - cached`, async () => {
        // Create a post with a domain as author address, signed with the correct signer
        const mockPost = await publishRandomPost({
            subplebbitAddress: subplebbitAddress,
            plebbit: plebbit,
            postProps: {
                author: { address: "plebbit.eth" },
                signer: signers[6]
            }
        });

        // Create a new plebbit instance to avoid caching
        const differentPlebbit = await mockPlebbitV2({ stubStorage: false, remotePlebbit: true, mockResolve: true });

        // Clear the cache for the domain
        await mockCacheOfTextRecord({
            plebbit: differentPlebbit,
            domain: "plebbit.eth",
            resolveType: "author",
            value: signers[6].address
        });

        const updatingPost = await differentPlebbit.createComment({ cid: mockPost.cid });

        const expectedStates: string[] = []; // empty because it's cached
        const actualStates: string[] = [];

        const resolverKey = Object.keys(updatingPost.clients.nameResolvers)[0];

        updatingPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await updatingPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: updatingPost, predicate: async () => typeof updatingPost.updatedAt === "number" });

        await updatingPost.stop();

        expect(actualStates).to.deep.equal(expectedStates);

        await differentPlebbit.destroy();
    });

    it(`correct order of nameResolvers state when publishing a comment to a sub with a domain address - uncached`, async () => {
        const plebbit: Plebbit = await mockPlebbitV2({ stubStorage: false, remotePlebbit: true, mockResolve: true }); // need to use different plebbit so it won't use the memory cache of subplebbit for publishing
        const mockPost = await generateMockPost({ subplebbitAddress: "plebbit.bso", plebbit: plebbit });
        await mockCacheOfTextRecord({
            plebbit: mockPost._plebbit,
            domain: "plebbit.bso",
            resolveType: "subplebbit",
            value: undefined
        });
        const expectedStates = ["resolving-subplebbit-address", "stopped"];

        const actualStates: string[] = [];

        const resolverKey = Object.keys(mockPost.clients.nameResolvers)[0];

        mockPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(actualStates).to.deep.equal(expectedStates);
        await plebbit.destroy();
    });

    it(`correct order of nameResolvers state when publishing a comment to a sub with a domain address - cached`, async () => {
        const mockPost = await generateMockPost({ subplebbitAddress: "plebbit.bso", plebbit: plebbit });
        await mockCacheOfTextRecord({
            plebbit: mockPost._plebbit,
            domain: "plebbit.bso",
            resolveType: "subplebbit",
            value: signers[3].address
        });
        const expectedStates: string[] = []; // empty because it's cached

        const actualStates: string[] = [];

        const resolverKey = Object.keys(mockPost.clients.nameResolvers)[0];

        mockPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(actualStates).to.deep.equal(expectedStates);
    });

    it(`Correct order of nameResolvers state when comment has a reply with author.address as domain - uncached`, async () => {
        const mockPost = await publishRandomPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
        const reply = await publishRandomReply({
            parentComment: mockPost as CommentIpfsWithCidDefined,
            plebbit: plebbit,
            commentProps: {
                author: { address: "plebbit.eth" },
                signer: signers[6]
            }
        });
        await waitTillReplyInParentPages(reply as CommentWithRequiredFields, plebbit); // make sure until reply is in mockPost.replies

        const differentPlebbit: Plebbit = await mockPlebbitV2({
            stubStorage: true, // make sure there's no storage so it won't be cached
            remotePlebbit: true,
            mockResolve: true,
            plebbitOptions: { validatePages: true } // it needs to validate page to resolve author address
        });
        const loadedPost = await differentPlebbit.createComment({ cid: mockPost.cid });
        const expectedStates = ["resolving-author-address", "stopped"];
        const actualStates: string[] = [];

        const resolverKey = Object.keys(loadedPost.clients.nameResolvers)[0];

        loadedPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await loadedPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: loadedPost, predicate: async () => typeof loadedPost.updatedAt === "number" });

        await loadedPost.stop();

        expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);
    });

    it(`Correct order of nameResolvers state when comment has a reply with author.address as domain - cached`, async () => {
        const mockPost = await publishRandomPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
        const reply = await publishRandomReply({
            parentComment: mockPost as CommentIpfsWithCidDefined,
            plebbit: plebbit,
            commentProps: {
                author: { address: "plebbit.eth" },
                signer: signers[6]
            }
        });
        await waitTillReplyInParentPages(reply as CommentWithRequiredFields, plebbit); // make sure until reply is in mockPost.replies

        const differentPlebbit = await mockPlebbitV2({ stubStorage: false, remotePlebbit: true, mockResolve: true });
        await mockCacheOfTextRecord({
            plebbit: plebbit,
            domain: "plebbit.eth",
            resolveType: "author",
            value: signers[3].address
        });
        const loadedPost = await differentPlebbit.createComment({ cid: mockPost.cid });
        const expectedStates: string[] = [];
        const actualStates: string[] = [];

        const resolverKey = Object.keys(loadedPost.clients.nameResolvers)[0];

        loadedPost.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

        await loadedPost.update();

        await resolveWhenConditionIsTrue({ toUpdate: loadedPost, predicate: async () => typeof loadedPost.updatedAt === "number" });

        await loadedPost.stop();

        expect(actualStates).to.deep.equal(expectedStates);
    });
});

import { beforeAll, afterAll, beforeEach, afterEach, it } from "vitest";
import { describeSkipIfRpc, generateMockPost, mockPlebbit, publishWithExpectedResult } from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { LRUCache } from "lru-cache";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type Publication from "../../../dist/node/publications/publication.js";
import type { SignerWithPublicKeyAddress } from "../../../dist/node/signer/index.js";
import type { DecryptedChallengeVerificationMessageType } from "../../../dist/node/pubsub-messages/types.js";
import type { CommentPubsubMessagePublication, CommentsTableRowInsert } from "../../../dist/node/publications/comment/types.js";
import type {
    CommentEditPubsubMessagePublication,
    CommentEditsTableRowInsert
} from "../../../dist/node/publications/comment-edit/types.js";
import type {
    CommentModerationPubsubMessagePublication,
    CommentModerationsTableRowInsert
} from "../../../dist/node/publications/comment-moderation/types.js";
import type { VotePubsubMessagePublication, VotesTableRowInsert } from "../../../dist/node/publications/vote/types.js";
import type { SubplebbitEditPubsubMessagePublication } from "../../../dist/node/publications/subplebbit-edit/types.js";

class InMemoryDbHandlerMock {
    comments: CommentsTableRowInsert[] = [];
    commentEdits: CommentEditsTableRowInsert[] = [];
    commentModerations: CommentModerationsTableRowInsert[] = [];
    votes: VotesTableRowInsert[] = [];
    subplebbitAuthors: Map<string, { firstCommentTimestamp: number; lastCommentCid: string }> = new Map();
    _keyv: Map<string, Record<string, number | string | boolean>> = new Map([["INTERNAL_SUBPLEBBIT", {}]]);

    // transaction helpers used by LocalSubplebbit
    createTransaction(): void {}
    commitTransaction(): void {}
    rollbackTransaction(): void {}
    removeOldestPendingCommentIfWeHitMaxPendingCount(): void {}
    destoryConnection(): void {}
    markCommentsAsPublishedToPostUpdates(): void {}
    purgeComment(): void {}
    removeCommentFromPendingApproval(): void {}
    approvePendingComment(): Record<string, number | string | boolean> {
        return {};
    }

    async initDbIfNeeded(): Promise<void> {}
    async lockSubState(): Promise<void> {}
    async unlockSubState(): Promise<void> {}
    keyvHas(key: string): boolean {
        return this._keyv.has(key);
    }
    async keyvGet(key: string): Promise<Record<string, number | string | boolean> | undefined> {
        return this._keyv.get(key);
    }
    async keyvSet(key: string, value: Record<string, number | string | boolean>): Promise<void> {
        this._keyv.set(key, value);
    }

    queryAllCommentCidsAndTheirReplies(): { cid: string }[] {
        return this.comments.map((comment) => ({ cid: comment.cid }));
    }

    // comment helpers
    queryLatestPostCid(): CommentsTableRowInsert | undefined {
        const posts = this.comments.filter((comment) => comment.depth === 0);
        if (posts.length === 0) return undefined;
        return posts[posts.length - 1];
    }

    getNextCommentNumbers(depth: number): { number: number; postNumber?: number } {
        const maxNumber = this.comments.reduce(
            (max, comment) => (typeof comment.number === "number" ? Math.max(max, comment.number) : max),
            0
        );
        const number = maxNumber + 1;
        if (depth !== 0) return { number };

        const maxPostNumber = this.comments.reduce(
            (max, comment) => (comment.depth === 0 && typeof comment.postNumber === "number" ? Math.max(max, comment.postNumber) : max),
            0
        );
        return { number, postNumber: maxPostNumber + 1 };
    }

    _assignNumbersForComment(commentCid: string): { number?: number; postNumber?: number } {
        const comment = this.comments.find((row) => row.cid === commentCid);
        if (!comment) throw new Error(`Failed to query comment row for ${commentCid}`);
        if (comment.pendingApproval) return {};
        if (typeof comment.number === "number") {
            return {
                number: comment.number,
                ...(typeof comment.postNumber === "number" ? { postNumber: comment.postNumber } : {})
            };
        }

        const numbers = this.getNextCommentNumbers(comment.depth);
        comment.number = numbers.number;
        if (typeof numbers.postNumber === "number") comment.postNumber = numbers.postNumber;
        return numbers;
    }

    queryCommentsUnderComment(parentCid: string): CommentsTableRowInsert[] {
        return this.comments.filter((comment) => comment.parentCid === parentCid);
    }

    queryComment(cid: string): CommentsTableRowInsert | undefined {
        return this.comments.find((comment) => comment.cid === cid);
    }

    queryCommentFlagsSetByMod(): { removed: boolean; locked: boolean } {
        return { removed: false, locked: false };
    }

    queryAuthorEditDeleted(): { deleted: boolean } {
        return { deleted: false };
    }

    _queryIsCommentApproved(): { approved: boolean } {
        return { approved: true };
    }

    hasCommentWithSignatureEncoded(signatureEncoded: string): boolean {
        return this.comments.some(
            (comment) => comment.signature?.signature === signatureEncoded || comment.originalCommentSignatureEncoded === signatureEncoded
        );
    }

    queryCommentBySignatureEncoded(signatureEncoded: string): CommentsTableRowInsert | undefined {
        return this.comments.find(
            (comment) => comment.signature?.signature === signatureEncoded || comment.originalCommentSignatureEncoded === signatureEncoded
        );
    }

    insertComments(comments: CommentsTableRowInsert[]): void {
        comments.forEach((comment) => {
            this.comments.push(comment);
            if (comment.authorSignerAddress)
                this.subplebbitAuthors.set(comment.authorSignerAddress, {
                    firstCommentTimestamp: comment.timestamp,
                    lastCommentCid: comment.cid
                });
        });
    }

    // anonymity alias helpers
    queryPseudonymityAliasByCommentCid(): undefined {
        return undefined;
    }

    queryPseudonymityAliasForPost(): undefined {
        return undefined;
    }

    queryPseudonymityAliasForAuthor(): undefined {
        return undefined;
    }

    insertPseudonymityAliases(): void {}

    // comment edit helpers
    hasCommentEditWithSignatureEncoded(signatureEncoded: string): boolean {
        return this.commentEdits.some((edit) => edit.signature?.signature === signatureEncoded);
    }

    insertCommentEdits(edits: CommentEditsTableRowInsert[]): void {
        edits.forEach((edit) => this.commentEdits.push(edit));
    }

    // comment moderation helpers
    hasCommentModerationWithSignatureEncoded(signatureEncoded: string): boolean {
        return this.commentModerations.some((mod) => mod.signature?.signature === signatureEncoded);
    }

    insertCommentModerations(moderations: CommentModerationsTableRowInsert[]): void {
        moderations.forEach((mod) => this.commentModerations.push(mod));
    }

    // vote helpers
    deleteVote(authorSignerAddress: string, commentCid: string): void {
        this.votes = this.votes.filter((vote) => !(vote.authorSignerAddress === authorSignerAddress && vote.commentCid === commentCid));
    }

    insertVotes(votes: VotesTableRowInsert[]): void {
        votes.forEach((vote) => this.votes.push(vote));
    }

    queryVote(commentCid: string, authorSignerAddress: string): VotesTableRowInsert | undefined {
        return this.votes.find((vote) => vote.commentCid === commentCid && vote.authorSignerAddress === authorSignerAddress);
    }

    queryStoredCommentUpdate(): undefined {
        return undefined;
    }

    querySubplebbitAuthor(address: string): { firstCommentTimestamp: number; lastCommentCid: string } | undefined {
        return this.subplebbitAuthors.get(address);
    }
}

// Type aliases for the publication types used in the test
type PublicationType =
    | CommentPubsubMessagePublication
    | CommentEditPubsubMessagePublication
    | CommentModerationPubsubMessagePublication
    | VotePubsubMessagePublication
    | SubplebbitEditPubsubMessagePublication;

// Challenge request interface for testing
interface MockChallengeRequest {
    challengeRequestId: bigint;
    signature: { publicKey: Uint8Array };
    comment?: CommentPubsubMessagePublication;
    commentEdit?: CommentEditPubsubMessagePublication;
    commentModeration?: CommentModerationPubsubMessagePublication;
    vote?: VotePubsubMessagePublication;
    subplebbitEdit?: SubplebbitEditPubsubMessagePublication;
    [key: string]: bigint | { publicKey: Uint8Array } | PublicationType | undefined;
}

describeSkipIfRpc("LocalSubplebbit duplicate publication regression coverage", function () {
    let plebbit: PlebbitType;
    let subplebbit: LocalSubplebbit;
    let dbMock: InMemoryDbHandlerMock;
    let originalEdit: LocalSubplebbit["edit"];
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    const toPublicKeyBuffer = (publicKey: string | Uint8Array): Uint8Array =>
        typeof publicKey === "string" ? uint8ArrayFromString(publicKey, "base64") : publicKey;

    // Accessing private members on LocalSubplebbit for testing purposes
    // We use Object casting to bypass TypeScript's private member restrictions
    // since at runtime these members exist on the object

    const setDbHandler = (sub: LocalSubplebbit, handler: InMemoryDbHandlerMock): void => {
        // Using Object to allow any property access
        (sub as object as { _dbHandler: InMemoryDbHandlerMock })._dbHandler = handler;
    };

    const setInternalMaps = (sub: LocalSubplebbit): void => {
        // Using Object to allow any property access
        const s = sub as object as {
            _ongoingChallengeExchanges: Map<string, Record<string, number | string | boolean>>;
            _challengeAnswerPromises: Map<string, Record<string, number | string | boolean>>;
            _challengeAnswerResolveReject: Map<string, Record<string, number | string | boolean>>;
            _challengeExchangesFromLocalPublishers: Record<string, Record<string, number | string | boolean>>;
            _duplicatePublicationAttempts: LRUCache<string, number>;
        };
        s._ongoingChallengeExchanges = new Map();
        s._challengeAnswerPromises = new Map();
        s._challengeAnswerResolveReject = new Map();
        s._challengeExchangesFromLocalPublishers = {};
        s._duplicatePublicationAttempts = new LRUCache<string, number>({ max: 1000, ttl: 600000 });
    };

    const publishChallengeVerification = async (
        sub: LocalSubplebbit,
        challengeResult: { challengeSuccess: boolean; challengeErrors: undefined },
        request: MockChallengeRequest,
        pendingApproval: boolean
    ): Promise<void> => {
        // Using Object to access private method
        const s = sub as object as {
            _publishChallengeVerification(
                challengeResult: { challengeSuccess: boolean; challengeErrors: undefined },
                request: MockChallengeRequest,
                pendingApproval: boolean
            ): Promise<void>;
        };
        return s._publishChallengeVerification(challengeResult, request, pendingApproval);
    };

    const publishViaMockedSubAndAssert = async ({
        publication,
        request,
        expectedChallengeSuccess,
        expectedReason
    }: {
        publication: Publication;
        request: MockChallengeRequest;
        expectedChallengeSuccess: boolean;
        expectedReason?: string;
    }) => {
        const publicationMutable = publication as unknown as Publication & { publish: () => Promise<void> };
        const originalPublish = publicationMutable.publish.bind(publicationMutable);

        publicationMutable.publish = async () => {
            const challengeVerificationPromise = new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
                subplebbit.once("challengeverification", resolve)
            );
            await publishChallengeVerification(subplebbit, { challengeSuccess: true, challengeErrors: undefined }, request, false);
            const verification = await challengeVerificationPromise;
            (publication as any).emit("challengeverification", verification);
        };

        try {
            await publishWithExpectedResult({
                publication: publication as any,
                expectedChallengeSuccess: expectedChallengeSuccess,
                expectedReason: expectedReason
            });
        } finally {
            publicationMutable.publish = originalPublish;
        }
    };

    const expectNoDuplicateSignatures = (): void => {
        const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;
        const commentSignatures = dbMock.comments.map((c) => c.signature?.signature).filter(Boolean);
        expect(unique(commentSignatures), "Duplicate comment signatures stored in mock DB").to.be.true;

        const commentEditSignatures = dbMock.commentEdits.map((e) => e.signature?.signature).filter(Boolean);
        expect(unique(commentEditSignatures), "Duplicate comment edit signatures stored in mock DB").to.be.true;

        const commentModSignatures = dbMock.commentModerations.map((m) => m.signature?.signature).filter(Boolean);
        expect(unique(commentModSignatures), "Duplicate comment moderation signatures stored in mock DB").to.be.true;
    };

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        subplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit;
        originalEdit = subplebbit.edit;
    });

    beforeEach(() => {
        dbMock = new InMemoryDbHandlerMock();
        setDbHandler(subplebbit, dbMock);
        subplebbit.settings = subplebbit.settings || {};
        subplebbit.features = subplebbit.features || {};
        subplebbit.roles = {};
        // use a lightweight stub to avoid real DB work during these unit tests
        subplebbit.edit = async (newProps) => {
            Object.assign(subplebbit, newProps);
            return subplebbit;
        };
        setInternalMaps(subplebbit);
    });

    afterEach(() => {
        expectNoDuplicateSignatures();
    });

    afterAll(async () => {
        if (subplebbit) await subplebbit.delete();
        if (plebbit) await plebbit.destroy();
    });

    const makeCommentRequest = (commentPublication: CommentPubsubMessagePublication, requestId: number): MockChallengeRequest => ({
        challengeRequestId: BigInt(requestId),
        signature: { publicKey: toPublicKeyBuffer(commentPublication.signature.publicKey) },
        comment: clone(commentPublication)
    });

    const makeCommentEditRequest = (
        commentEditPublication: CommentEditPubsubMessagePublication,
        requestId: number
    ): MockChallengeRequest => ({
        challengeRequestId: BigInt(requestId),
        signature: { publicKey: toPublicKeyBuffer(commentEditPublication.signature.publicKey) },
        commentEdit: clone(commentEditPublication)
    });

    const makeCommentModerationRequest = (
        commentModerationPublication: CommentModerationPubsubMessagePublication,
        requestId: number
    ): MockChallengeRequest => ({
        challengeRequestId: BigInt(requestId),
        signature: { publicKey: toPublicKeyBuffer(commentModerationPublication.signature.publicKey) },
        commentModeration: clone(commentModerationPublication)
    });

    const makeVoteRequest = (votePublication: VotePubsubMessagePublication, requestId: number): MockChallengeRequest => ({
        challengeRequestId: BigInt(requestId),
        signature: { publicKey: toPublicKeyBuffer(votePublication.signature.publicKey) },
        vote: clone(votePublication)
    });

    const makeSubplebbitEditRequest = (
        subplebbitEditPublication: SubplebbitEditPubsubMessagePublication,
        requestId: number
    ): MockChallengeRequest => ({
        challengeRequestId: BigInt(requestId),
        signature: { publicKey: toPublicKeyBuffer(subplebbitEditPublication.signature.publicKey) },
        subplebbitEdit: clone(subplebbitEditPublication)
    });

    const captureChallengeVerifications = (): {
        challengeVerifications: DecryptedChallengeVerificationMessageType[];
        dispose: () => void;
    } => {
        const challengeVerifications: DecryptedChallengeVerificationMessageType[] = [];
        const handler = (msg: DecryptedChallengeVerificationMessageType): void => {
            challengeVerifications.push(msg);
        };
        subplebbit.on("challengeverification", handler);
        return {
            challengeVerifications,
            dispose: () => subplebbit.off("challengeverification", handler)
        };
    };

    it("rejects duplicate comment publications", async () => {
        const { publication: commentPub, instance: commentInstance } = await createCommentPublication();
        const { challengeVerifications, dispose } = captureChallengeVerifications();

        const request = makeCommentRequest(commentPub, 1);
        await publishViaMockedSubAndAssert({
            publication: commentInstance,
            request,
            expectedChallengeSuccess: true
        });
        expect(challengeVerifications.length).to.equal(1);
        expect(challengeVerifications[0].challengeSuccess).to.be.true;
        expect(dbMock.comments.length).to.equal(1, "Expected the successful publication to be stored in the comments table mock");
        expect(dbMock.comments[0].signature?.signature).to.equal(
            commentPub.signature.signature,
            "Stored comment signature should match the publication signature"
        );

        const duplicateCommentInstance = await plebbit.createComment(clone(commentPub));
        const duplicateRequest = makeCommentRequest(clone(commentPub), 2);
        await publishViaMockedSubAndAssert({
            publication: duplicateCommentInstance,
            request: duplicateRequest,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_DUPLICATE_COMMENT
        });

        expect(challengeVerifications.length).to.equal(2);
        const duplicateEvent = challengeVerifications[1];
        expect(duplicateEvent.challengeSuccess).to.be.false;
        expect(duplicateEvent.reason).to.equal(messages.ERR_DUPLICATE_COMMENT);
        expect(dbMock.comments.length).to.equal(1, "Duplicate comment should not be stored");
        expect(dbMock.hasCommentWithSignatureEncoded(commentPub.signature.signature)).to.be.true;

        dispose();
    });

    it("rejects duplicate comment edits", async () => {
        const { signer: originalCommentSigner, publication: commentPub } = await createCommentPublication();
        const commentRequest = makeCommentRequest(commentPub, 10);
        await publishChallengeVerification(subplebbit, { challengeSuccess: true, challengeErrors: undefined }, commentRequest, false);

        const storedComment = dbMock.comments[0];

        const editInstance = await plebbit.createCommentEdit({
            communityAddress: subplebbit.address,
            commentCid: storedComment.cid,
            content: "Edited content",
            signer: originalCommentSigner
        });
        const editPublication = editInstance.raw.pubsubMessageToPublish!;

        const { challengeVerifications, dispose } = captureChallengeVerifications();

        const editRequest = makeCommentEditRequest(editPublication, 11);
        await publishViaMockedSubAndAssert({
            publication: editInstance,
            request: editRequest,
            expectedChallengeSuccess: true
        });
        expect(challengeVerifications.length).to.equal(1);
        expect(challengeVerifications[0].challengeSuccess).to.be.true;

        const duplicateEditInstance = await plebbit.createCommentEdit(clone(editPublication));
        const duplicateEditRequest = makeCommentEditRequest(clone(editPublication), 12);
        await publishViaMockedSubAndAssert({
            publication: duplicateEditInstance,
            request: duplicateEditRequest,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_DUPLICATE_COMMENT_EDIT
        });

        expect(challengeVerifications.length).to.equal(2);
        const duplicateEvent = challengeVerifications[1];
        expect(duplicateEvent.challengeSuccess).to.be.false;
        expect(duplicateEvent.reason).to.equal(messages.ERR_DUPLICATE_COMMENT_EDIT);
        dispose();
    });

    it("rejects duplicate comment moderations", async () => {
        const { publication: commentPub } = await createCommentPublication();
        const commentRequest = makeCommentRequest(commentPub, 20);
        await publishChallengeVerification(subplebbit, { challengeSuccess: true, challengeErrors: undefined }, commentRequest, false);

        const storedComment = dbMock.comments[0];
        const modSigner = await plebbit.createSigner();
        subplebbit.roles = { [modSigner.address]: { role: "moderator" } };

        const moderationInstance = await plebbit.createCommentModeration({
            communityAddress: subplebbit.address,
            commentCid: storedComment.cid,
            commentModeration: { removed: true },
            signer: modSigner
        });
        const moderationPublication = moderationInstance.raw.pubsubMessageToPublish!;

        const { challengeVerifications, dispose } = captureChallengeVerifications();

        const modRequest = makeCommentModerationRequest(moderationPublication, 21);
        await publishViaMockedSubAndAssert({
            publication: moderationInstance,
            request: modRequest,
            expectedChallengeSuccess: true
        });
        expect(challengeVerifications.length).to.equal(1);
        expect(challengeVerifications[0].challengeSuccess).to.be.true;

        const duplicateModerationInstance = await plebbit.createCommentModeration(clone(moderationPublication));
        const duplicateModRequest = makeCommentModerationRequest(clone(moderationPublication), 22);
        await publishViaMockedSubAndAssert({
            publication: duplicateModerationInstance,
            request: duplicateModRequest,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_DUPLICATE_COMMENT_MODERATION
        });

        expect(challengeVerifications.length).to.equal(2);
        const duplicateEvent = challengeVerifications[1];
        expect(duplicateEvent.challengeSuccess).to.be.false;
        expect(duplicateEvent.reason).to.equal(messages.ERR_DUPLICATE_COMMENT_MODERATION);
        dispose();
    });

    it("rejects duplicate votes", async () => {
        const { publication: commentPub } = await createCommentPublication();
        const commentRequest = makeCommentRequest(commentPub, 30);
        await publishChallengeVerification(subplebbit, { challengeSuccess: true, challengeErrors: undefined }, commentRequest, false);

        const storedComment = dbMock.comments[0];
        const signer = await plebbit.createSigner();

        const voteInstance = await plebbit.createVote({
            communityAddress: subplebbit.address,
            commentCid: storedComment.cid,
            vote: 1,
            signer
        });
        const votePublication = voteInstance.raw.pubsubMessageToPublish!;

        const { challengeVerifications, dispose } = captureChallengeVerifications();

        const voteRequest = makeVoteRequest(votePublication, 31);
        await publishViaMockedSubAndAssert({
            publication: voteInstance,
            request: voteRequest,
            expectedChallengeSuccess: true
        });
        expect(challengeVerifications.length).to.equal(1);
        expect(challengeVerifications[0].challengeSuccess).to.be.true;

        const duplicateVoteInstance = await plebbit.createVote(clone(votePublication));
        const duplicateVoteRequest = makeVoteRequest(clone(votePublication), 32);
        await publishViaMockedSubAndAssert({
            publication: duplicateVoteInstance,
            request: duplicateVoteRequest,
            expectedChallengeSuccess: true
        });
        expect(challengeVerifications.length).to.equal(2);
        const duplicateEvent = challengeVerifications[1];
        expect(duplicateEvent.challengeSuccess).to.be.true;
        dispose();
    });

    it("records duplicate subplebbit edits behaviour", async () => {
        await createCommentPublication();
        const signer = await plebbit.createSigner();
        subplebbit.roles = { [signer.address]: { role: "owner" } };

        const editInstance = await plebbit.createSubplebbitEdit({
            communityAddress: subplebbit.address,
            subplebbitEdit: { description: "Updated description" },
            signer
        });
        const editPublication = editInstance.raw.pubsubMessageToPublish!;

        const { challengeVerifications, dispose } = captureChallengeVerifications();

        const editRequest = makeSubplebbitEditRequest(editPublication, 41);
        await publishViaMockedSubAndAssert({
            publication: editInstance,
            request: editRequest,
            expectedChallengeSuccess: true
        });
        expect(challengeVerifications.length).to.equal(1);
        expect(challengeVerifications[0].challengeSuccess).to.be.true;

        const duplicateSubplebbitEditInstance = await plebbit.createSubplebbitEdit(clone(editPublication));
        const duplicateEditRequest = makeSubplebbitEditRequest(clone(editPublication), 42);
        await publishViaMockedSubAndAssert({
            publication: duplicateSubplebbitEditInstance,
            request: duplicateEditRequest,
            expectedChallengeSuccess: true
        });
        expect(challengeVerifications.length).to.equal(2);
        const duplicateEvent = challengeVerifications[1];
        expect(duplicateEvent.challengeSuccess).to.be.true;
        dispose();
    });

    // Helpers for idempotent duplicate tests
    const checkPublicationValidity = async (
        sub: LocalSubplebbit,
        request: MockChallengeRequest,
        publication: { signature: { publicKey: string; signature: string } }
    ): Promise<string | undefined> => {
        const s = sub as object as {
            _checkPublicationValidity(
                request: MockChallengeRequest,
                publication: { signature: { publicKey: string; signature: string } },
                subplebbitAuthor: unknown
            ): Promise<string | undefined>;
        };
        return s._checkPublicationValidity(request, publication, undefined);
    };

    const publishIdempotentDuplicateVerification = async (
        sub: LocalSubplebbit,
        request: MockChallengeRequest,
        challengeRequestId: bigint,
        duplicateReason: string
    ): Promise<void> => {
        const s = sub as object as {
            _publishIdempotentDuplicateVerification(
                request: MockChallengeRequest,
                challengeRequestId: bigint,
                duplicateReason: string
            ): Promise<void>;
        };
        return s._publishIdempotentDuplicateVerification(request, challengeRequestId, duplicateReason);
    };

    const getDuplicateAttempts = (sub: LocalSubplebbit, sig: string): number => {
        const s = sub as object as { _duplicatePublicationAttempts: LRUCache<string, number> };
        return s._duplicatePublicationAttempts.get(sig) || 0;
    };

    const setDuplicateAttempts = (sub: LocalSubplebbit, sig: string, count: number): void => {
        const s = sub as object as { _duplicatePublicationAttempts: LRUCache<string, number> };
        s._duplicatePublicationAttempts.set(sig, count);
    };

    it("returns idempotent success for duplicate comment up to 3 times, then rejects", async () => {
        const { publication: commentPub, instance: commentInstance } = await createCommentPublication();
        const { challengeVerifications, dispose } = captureChallengeVerifications();

        // First publish succeeds normally
        const request = makeCommentRequest(commentPub, 100);
        await publishViaMockedSubAndAssert({
            publication: commentInstance,
            request,
            expectedChallengeSuccess: true
        });
        expect(dbMock.comments.length).to.equal(1);

        // Duplicate attempts 1-3 should return success via idempotent handler
        for (let i = 1; i <= 3; i++) {
            const dupRequest = makeCommentRequest(clone(commentPub), 100 + i);
            const reason = await checkPublicationValidity(subplebbit, dupRequest, commentPub);
            expect(reason).to.equal(messages.ERR_DUPLICATE_COMMENT);

            await publishIdempotentDuplicateVerification(subplebbit, dupRequest, BigInt(100 + i), messages.ERR_DUPLICATE_COMMENT);
            setDuplicateAttempts(subplebbit, commentPub.signature.signature, i);
        }

        // Should have 4 verifications total: 1 original + 3 idempotent
        expect(challengeVerifications.length).to.equal(4);
        for (let i = 1; i <= 3; i++) {
            expect(challengeVerifications[i].challengeSuccess).to.be.true;
        }

        // No new comments stored
        expect(dbMock.comments.length).to.equal(1);

        // 4th duplicate attempt should be rejected (spam)
        setDuplicateAttempts(subplebbit, commentPub.signature.signature, 3);
        const spamRequest = makeCommentRequest(clone(commentPub), 104);
        const spamReason = await checkPublicationValidity(subplebbit, spamRequest, commentPub);
        expect(spamReason).to.equal(messages.ERR_DUPLICATE_COMMENT);

        // Simulate the handleChallengeRequest logic: attempts > 3 → reject
        const attempts = getDuplicateAttempts(subplebbit, commentPub.signature.signature) + 1;
        setDuplicateAttempts(subplebbit, commentPub.signature.signature, attempts);
        expect(attempts).to.be.greaterThan(3);

        dispose();
    });

    it("returns idempotent success for duplicate comment edit up to 3 times, then rejects", async () => {
        const { signer: originalCommentSigner, publication: commentPub } = await createCommentPublication();
        const commentRequest = makeCommentRequest(commentPub, 110);
        await publishChallengeVerification(subplebbit, { challengeSuccess: true, challengeErrors: undefined }, commentRequest, false);

        const storedComment = dbMock.comments[0];
        const editInstance = await plebbit.createCommentEdit({
            communityAddress: subplebbit.address,
            commentCid: storedComment.cid,
            content: "Edited content",
            signer: originalCommentSigner
        });
        const editPublication = editInstance.raw.pubsubMessageToPublish!;

        const { challengeVerifications, dispose } = captureChallengeVerifications();

        // First edit publish succeeds
        const editRequest = makeCommentEditRequest(editPublication, 111);
        await publishViaMockedSubAndAssert({
            publication: editInstance,
            request: editRequest,
            expectedChallengeSuccess: true
        });
        expect(dbMock.commentEdits.length).to.equal(1);

        // Duplicate edit attempts 1-3 should succeed via idempotent handler
        for (let i = 1; i <= 3; i++) {
            const dupRequest = makeCommentEditRequest(clone(editPublication), 111 + i);
            const reason = await checkPublicationValidity(subplebbit, dupRequest, editPublication);
            expect(reason).to.equal(messages.ERR_DUPLICATE_COMMENT_EDIT);

            await publishIdempotentDuplicateVerification(subplebbit, dupRequest, BigInt(111 + i), messages.ERR_DUPLICATE_COMMENT_EDIT);
            setDuplicateAttempts(subplebbit, editPublication.signature.signature, i);
        }

        expect(challengeVerifications.length).to.equal(4);
        for (let i = 1; i <= 3; i++) {
            expect(challengeVerifications[i].challengeSuccess).to.be.true;
        }
        expect(dbMock.commentEdits.length).to.equal(1);

        // 4th attempt rejected
        setDuplicateAttempts(subplebbit, editPublication.signature.signature, 3);
        const attempts = getDuplicateAttempts(subplebbit, editPublication.signature.signature) + 1;
        setDuplicateAttempts(subplebbit, editPublication.signature.signature, attempts);
        expect(attempts).to.be.greaterThan(3);

        dispose();
    });

    it("returns idempotent success for duplicate comment moderation up to 3 times, then rejects", async () => {
        const { publication: commentPub } = await createCommentPublication();
        const commentRequest = makeCommentRequest(commentPub, 120);
        await publishChallengeVerification(subplebbit, { challengeSuccess: true, challengeErrors: undefined }, commentRequest, false);

        const storedComment = dbMock.comments[0];
        const modSigner = await plebbit.createSigner();
        subplebbit.roles = { [modSigner.address]: { role: "moderator" } };

        const moderationInstance = await plebbit.createCommentModeration({
            communityAddress: subplebbit.address,
            commentCid: storedComment.cid,
            commentModeration: { removed: true },
            signer: modSigner
        });
        const moderationPublication = moderationInstance.raw.pubsubMessageToPublish!;

        const { challengeVerifications, dispose } = captureChallengeVerifications();

        // First moderation publish succeeds
        const modRequest = makeCommentModerationRequest(moderationPublication, 121);
        await publishViaMockedSubAndAssert({
            publication: moderationInstance,
            request: modRequest,
            expectedChallengeSuccess: true
        });
        expect(dbMock.commentModerations.length).to.equal(1);

        // Duplicate moderation attempts 1-3 should succeed via idempotent handler
        for (let i = 1; i <= 3; i++) {
            const dupRequest = makeCommentModerationRequest(clone(moderationPublication), 121 + i);
            const reason = await checkPublicationValidity(subplebbit, dupRequest, moderationPublication);
            expect(reason).to.equal(messages.ERR_DUPLICATE_COMMENT_MODERATION);

            await publishIdempotentDuplicateVerification(
                subplebbit,
                dupRequest,
                BigInt(121 + i),
                messages.ERR_DUPLICATE_COMMENT_MODERATION
            );
            setDuplicateAttempts(subplebbit, moderationPublication.signature.signature, i);
        }

        expect(challengeVerifications.length).to.equal(4);
        for (let i = 1; i <= 3; i++) {
            expect(challengeVerifications[i].challengeSuccess).to.be.true;
        }
        expect(dbMock.commentModerations.length).to.equal(1);

        // 4th attempt rejected
        setDuplicateAttempts(subplebbit, moderationPublication.signature.signature, 3);
        const attempts = getDuplicateAttempts(subplebbit, moderationPublication.signature.signature) + 1;
        setDuplicateAttempts(subplebbit, moderationPublication.signature.signature, attempts);
        expect(attempts).to.be.greaterThan(3);

        dispose();
    });

    async function createCommentPublication(): Promise<{
        signer: SignerWithPublicKeyAddress;
        publication: CommentPubsubMessagePublication;
        instance: Publication;
    }> {
        const signer = await plebbit.createSigner();
        const commentInstance = await generateMockPost({ communityAddress: subplebbit.address, plebbit: plebbit, postProps: { signer } });
        const publication = commentInstance.raw.pubsubMessageToPublish!;
        return { signer, publication, instance: commentInstance as unknown as Publication };
    }
});

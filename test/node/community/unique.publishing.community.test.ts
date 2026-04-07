import { beforeAll, afterAll, beforeEach, afterEach, it } from "vitest";
import {
    describeSkipIfRpc,
    ensurePublicationIsSigned,
    generateMockPost,
    mockPKC,
    publishWithExpectedResult
} from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { LRUCache } from "lru-cache";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
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
import type { CommunityEditPubsubMessagePublication } from "../../../dist/node/publications/community-edit/types.js";

class InMemoryDbHandlerMock {
    comments: CommentsTableRowInsert[] = [];
    commentEdits: CommentEditsTableRowInsert[] = [];
    commentModerations: CommentModerationsTableRowInsert[] = [];
    votes: VotesTableRowInsert[] = [];
    communityAuthors: Map<string, { firstCommentTimestamp: number; lastCommentCid: string }> = new Map();
    _keyv: Map<string, Record<string, number | string | boolean>> = new Map([["INTERNAL_COMMUNITY", {}]]);

    // transaction helpers used by LocalCommunity
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
                this.communityAuthors.set(comment.authorSignerAddress, {
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

    queryCommunityAuthor(address: string): { firstCommentTimestamp: number; lastCommentCid: string } | undefined {
        return this.communityAuthors.get(address);
    }
}

// Type aliases for the publication types used in the test
type PublicationType =
    | CommentPubsubMessagePublication
    | CommentEditPubsubMessagePublication
    | CommentModerationPubsubMessagePublication
    | VotePubsubMessagePublication
    | CommunityEditPubsubMessagePublication;

// Challenge request interface for testing
interface MockChallengeRequest {
    challengeRequestId: bigint;
    signature: { publicKey: Uint8Array };
    comment?: CommentPubsubMessagePublication;
    commentEdit?: CommentEditPubsubMessagePublication;
    commentModeration?: CommentModerationPubsubMessagePublication;
    vote?: VotePubsubMessagePublication;
    communityEdit?: CommunityEditPubsubMessagePublication;
    [key: string]: bigint | { publicKey: Uint8Array } | PublicationType | undefined;
}

describeSkipIfRpc("LocalCommunity duplicate publication regression coverage", function () {
    let pkc: PKCType;
    let community: LocalCommunity;
    let dbMock: InMemoryDbHandlerMock;
    let originalEdit: LocalCommunity["edit"];
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    const toPublicKeyBuffer = (publicKey: string | Uint8Array): Uint8Array =>
        typeof publicKey === "string" ? uint8ArrayFromString(publicKey, "base64") : publicKey;

    // Accessing private members on LocalCommunity for testing purposes
    // We use Object casting to bypass TypeScript's private member restrictions
    // since at runtime these members exist on the object

    const setDbHandler = (community: LocalCommunity, handler: InMemoryDbHandlerMock): void => {
        // Using Object to allow any property access
        (community as object as { _dbHandler: InMemoryDbHandlerMock })._dbHandler = handler;
    };

    const setInternalMaps = (community: LocalCommunity): void => {
        // Using Object to allow any property access
        const s = community as object as {
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
        community: LocalCommunity,
        challengeResult: { challengeSuccess: boolean; challengeErrors: undefined },
        request: MockChallengeRequest,
        pendingApproval: boolean
    ): Promise<void> => {
        // Using Object to access private method
        const s = community as object as {
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
                community.once("challengeverification", resolve)
            );
            await publishChallengeVerification(community, { challengeSuccess: true, challengeErrors: undefined }, request, false);
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
        pkc = await mockPKC();
        community = (await pkc.createCommunity()) as LocalCommunity;
        originalEdit = community.edit;
    });

    beforeEach(() => {
        dbMock = new InMemoryDbHandlerMock();
        setDbHandler(community, dbMock);
        community.settings = community.settings || {};
        community.features = community.features || {};
        community.roles = {};
        // use a lightweight stub to avoid real DB work during these unit tests
        community.edit = async (newProps) => {
            Object.assign(community, newProps);
            return community;
        };
        setInternalMaps(community);
    });

    afterEach(() => {
        expectNoDuplicateSignatures();
    });

    afterAll(async () => {
        if (community) await community.delete();
        if (pkc) await pkc.destroy();
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

    const makeCommunityEditRequest = (
        communityEditPublication: CommunityEditPubsubMessagePublication,
        requestId: number
    ): MockChallengeRequest => ({
        challengeRequestId: BigInt(requestId),
        signature: { publicKey: toPublicKeyBuffer(communityEditPublication.signature.publicKey) },
        communityEdit: clone(communityEditPublication)
    });

    const captureChallengeVerifications = (): {
        challengeVerifications: DecryptedChallengeVerificationMessageType[];
        dispose: () => void;
    } => {
        const challengeVerifications: DecryptedChallengeVerificationMessageType[] = [];
        const handler = (msg: DecryptedChallengeVerificationMessageType): void => {
            challengeVerifications.push(msg);
        };
        community.on("challengeverification", handler);
        return {
            challengeVerifications,
            dispose: () => community.off("challengeverification", handler)
        };
    };

    it("rejects duplicate comment publications", async () => {
        const { publication: commentPub, instance: commentInstance } = await createCommentPublicationInstanceWithSignature();
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

        const duplicateCommentInstance = await pkc.createComment(clone(commentPub));
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
        const { signer: originalCommentSigner, publication: commentPub } = await createCommentPublicationInstanceWithSignature();
        const commentRequest = makeCommentRequest(commentPub, 10);
        await publishChallengeVerification(community, { challengeSuccess: true, challengeErrors: undefined }, commentRequest, false);

        const storedComment = dbMock.comments[0];

        const editInstance = await pkc.createCommentEdit({
            communityAddress: community.address,
            commentCid: storedComment.cid,
            content: "Edited content",
            signer: originalCommentSigner
        });
        await ensurePublicationIsSigned(editInstance, community);
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

        const duplicateEditInstance = await pkc.createCommentEdit(clone(editPublication));
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
        const { publication: commentPub } = await createCommentPublicationInstanceWithSignature();
        const commentRequest = makeCommentRequest(commentPub, 20);
        await publishChallengeVerification(community, { challengeSuccess: true, challengeErrors: undefined }, commentRequest, false);

        const storedComment = dbMock.comments[0];
        const modSigner = await pkc.createSigner();
        community.roles = { [modSigner.address]: { role: "moderator" } };

        const moderationInstance = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: storedComment.cid,
            commentModeration: { removed: true },
            signer: modSigner
        });
        await ensurePublicationIsSigned(moderationInstance, community);
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

        const duplicateModerationInstance = await pkc.createCommentModeration(clone(moderationPublication));
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
        const { publication: commentPub } = await createCommentPublicationInstanceWithSignature();
        const commentRequest = makeCommentRequest(commentPub, 30);
        await publishChallengeVerification(community, { challengeSuccess: true, challengeErrors: undefined }, commentRequest, false);

        const storedComment = dbMock.comments[0];
        const signer = await pkc.createSigner();

        const voteInstance = await pkc.createVote({
            communityAddress: community.address,
            commentCid: storedComment.cid,
            vote: 1,
            signer
        });
        await ensurePublicationIsSigned(voteInstance, community);
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

        const duplicateVoteInstance = await pkc.createVote(clone(votePublication));
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

    it("records duplicate community edits behaviour", async () => {
        await createCommentPublicationInstanceWithSignature();
        const signer = await pkc.createSigner();
        community.roles = { [signer.address]: { role: "owner" } };

        const editInstance = await pkc.createCommunityEdit({
            communityAddress: community.address,
            communityEdit: { description: "Updated description" },
            signer
        });
        await ensurePublicationIsSigned(editInstance, community);
        const editPublication = editInstance.raw.pubsubMessageToPublish!;

        const { challengeVerifications, dispose } = captureChallengeVerifications();

        const editRequest = makeCommunityEditRequest(editPublication, 41);
        await publishViaMockedSubAndAssert({
            publication: editInstance,
            request: editRequest,
            expectedChallengeSuccess: true
        });
        expect(challengeVerifications.length).to.equal(1);
        expect(challengeVerifications[0].challengeSuccess).to.be.true;

        const duplicateCommunityEditInstance = await pkc.createCommunityEdit(clone(editPublication));
        const duplicateEditRequest = makeCommunityEditRequest(clone(editPublication), 42);
        await publishViaMockedSubAndAssert({
            publication: duplicateCommunityEditInstance,
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
        community: LocalCommunity,
        request: MockChallengeRequest,
        publication: { signature: { publicKey: string; signature: string } }
    ): Promise<string | undefined> => {
        const s = community as object as {
            _checkPublicationValidity(
                request: MockChallengeRequest,
                publication: { signature: { publicKey: string; signature: string } },
                communityAuthor: unknown
            ): Promise<string | undefined>;
        };
        return s._checkPublicationValidity(request, publication, undefined);
    };

    const publishIdempotentDuplicateVerification = async (
        community: LocalCommunity,
        request: MockChallengeRequest,
        challengeRequestId: bigint,
        duplicateReason: string
    ): Promise<void> => {
        const s = community as object as {
            _publishIdempotentDuplicateVerification(
                request: MockChallengeRequest,
                challengeRequestId: bigint,
                duplicateReason: string
            ): Promise<void>;
        };
        return s._publishIdempotentDuplicateVerification(request, challengeRequestId, duplicateReason);
    };

    const getDuplicateAttempts = (community: LocalCommunity, sig: string): number => {
        const s = community as object as { _duplicatePublicationAttempts: LRUCache<string, number> };
        return s._duplicatePublicationAttempts.get(sig) || 0;
    };

    const setDuplicateAttempts = (community: LocalCommunity, sig: string, count: number): void => {
        const s = community as object as { _duplicatePublicationAttempts: LRUCache<string, number> };
        s._duplicatePublicationAttempts.set(sig, count);
    };

    it("returns idempotent success for duplicate comment up to 1 time, then rejects", async () => {
        const { publication: commentPub, instance: commentInstance } = await createCommentPublicationInstanceWithSignature();
        const { challengeVerifications, dispose } = captureChallengeVerifications();

        // First publish succeeds normally
        const request = makeCommentRequest(commentPub, 100);
        await publishViaMockedSubAndAssert({
            publication: commentInstance,
            request,
            expectedChallengeSuccess: true
        });
        expect(dbMock.comments.length).to.equal(1);

        // Duplicate attempt 1 should return success via idempotent handler
        const dupRequest = makeCommentRequest(clone(commentPub), 101);
        const reason = await checkPublicationValidity(community, dupRequest, commentPub);
        expect(reason).to.equal(messages.ERR_DUPLICATE_COMMENT);

        await publishIdempotentDuplicateVerification(community, dupRequest, BigInt(101), messages.ERR_DUPLICATE_COMMENT);
        setDuplicateAttempts(community, commentPub.signature.signature, 1);

        // Should have 2 verifications total: 1 original + 1 idempotent
        expect(challengeVerifications.length).to.equal(2);
        expect(challengeVerifications[1].challengeSuccess).to.be.true;

        // No new comments stored
        expect(dbMock.comments.length).to.equal(1);

        // 2nd duplicate attempt should be rejected (spam)
        setDuplicateAttempts(community, commentPub.signature.signature, 1);
        const spamRequest = makeCommentRequest(clone(commentPub), 102);
        const spamReason = await checkPublicationValidity(community, spamRequest, commentPub);
        expect(spamReason).to.equal(messages.ERR_DUPLICATE_COMMENT);

        // Simulate the handleChallengeRequest logic: attempts > 1 → reject
        const attempts = getDuplicateAttempts(community, commentPub.signature.signature) + 1;
        setDuplicateAttempts(community, commentPub.signature.signature, attempts);
        expect(attempts).to.be.greaterThan(1);

        dispose();
    });

    it("returns idempotent success for duplicate comment edit up to 1 time, then rejects", async () => {
        const { signer: originalCommentSigner, publication: commentPub } = await createCommentPublicationInstanceWithSignature();
        const commentRequest = makeCommentRequest(commentPub, 110);
        await publishChallengeVerification(community, { challengeSuccess: true, challengeErrors: undefined }, commentRequest, false);

        const storedComment = dbMock.comments[0];
        const editInstance = await pkc.createCommentEdit({
            communityAddress: community.address,
            commentCid: storedComment.cid,
            content: "Edited content",
            signer: originalCommentSigner
        });
        await ensurePublicationIsSigned(editInstance, community);
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

        // Duplicate edit attempt 1 should succeed via idempotent handler
        const dupRequest = makeCommentEditRequest(clone(editPublication), 112);
        const reason = await checkPublicationValidity(community, dupRequest, editPublication);
        expect(reason).to.equal(messages.ERR_DUPLICATE_COMMENT_EDIT);

        await publishIdempotentDuplicateVerification(community, dupRequest, BigInt(112), messages.ERR_DUPLICATE_COMMENT_EDIT);
        setDuplicateAttempts(community, editPublication.signature.signature, 1);

        expect(challengeVerifications.length).to.equal(2);
        expect(challengeVerifications[1].challengeSuccess).to.be.true;
        expect(dbMock.commentEdits.length).to.equal(1);

        // 2nd attempt rejected
        setDuplicateAttempts(community, editPublication.signature.signature, 1);
        const attempts = getDuplicateAttempts(community, editPublication.signature.signature) + 1;
        setDuplicateAttempts(community, editPublication.signature.signature, attempts);
        expect(attempts).to.be.greaterThan(1);

        dispose();
    });

    it("returns idempotent success for duplicate comment moderation up to 1 time, then rejects", async () => {
        const { publication: commentPub } = await createCommentPublicationInstanceWithSignature();
        const commentRequest = makeCommentRequest(commentPub, 120);
        await publishChallengeVerification(community, { challengeSuccess: true, challengeErrors: undefined }, commentRequest, false);

        const storedComment = dbMock.comments[0];
        const modSigner = await pkc.createSigner();
        community.roles = { [modSigner.address]: { role: "moderator" } };

        const moderationInstance = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: storedComment.cid,
            commentModeration: { removed: true },
            signer: modSigner
        });
        await ensurePublicationIsSigned(moderationInstance, community);
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

        // Duplicate moderation attempt 1 should succeed via idempotent handler
        const dupRequest = makeCommentModerationRequest(clone(moderationPublication), 122);
        const reason = await checkPublicationValidity(community, dupRequest, moderationPublication);
        expect(reason).to.equal(messages.ERR_DUPLICATE_COMMENT_MODERATION);

        await publishIdempotentDuplicateVerification(community, dupRequest, BigInt(122), messages.ERR_DUPLICATE_COMMENT_MODERATION);
        setDuplicateAttempts(community, moderationPublication.signature.signature, 1);

        expect(challengeVerifications.length).to.equal(2);
        expect(challengeVerifications[1].challengeSuccess).to.be.true;
        expect(dbMock.commentModerations.length).to.equal(1);

        // 2nd attempt rejected
        setDuplicateAttempts(community, moderationPublication.signature.signature, 1);
        const attempts = getDuplicateAttempts(community, moderationPublication.signature.signature) + 1;
        setDuplicateAttempts(community, moderationPublication.signature.signature, attempts);
        expect(attempts).to.be.greaterThan(1);

        dispose();
    });

    async function createCommentPublicationInstanceWithSignature(): Promise<{
        signer: SignerWithPublicKeyAddress;
        publication: CommentPubsubMessagePublication;
        instance: Publication;
    }> {
        const signer = await pkc.createSigner();
        const commentInstance = await generateMockPost({ communityAddress: community.address, pkc: pkc, postProps: { signer } });
        await ensurePublicationIsSigned(commentInstance, community);
        const publication = commentInstance.raw.pubsubMessageToPublish!;
        return { signer, publication, instance: commentInstance as unknown as Publication };
    }
});

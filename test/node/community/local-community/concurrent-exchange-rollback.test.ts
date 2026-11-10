// Issue #417: a failing challenge exchange rolls back another exchange's in-flight insert.
//
// A LocalCommunity has one DB connection, and its transaction depth is shared by every exchange that
// runs on it at the same time. storeComment and storeCommentEdit used to open a transaction, insert, then
// await the #387 store-time gate (an async CID calculation plus a signature verification) before they
// committed. Two things went wrong while that await was pending:
//
// - Direct: another exchange throws, and handleChallengeExchange's catch calls rollbackTransaction() on
//   a transaction it never opened. The ROLLBACK discards the half-finished insert, and the later
//   commitTransaction() finds depth 0 and does nothing. The publisher of the valid comment is told
//   `author.community can never be undefined after adding a comment`. CI hit this with the extraProp
//   request (crosspost.test.ts, run 39235375790) and with an undecryptable request (run 39240773267).
// - Collateral: every synchronous write made meanwhile lands inside the open transaction: a vote or
//   moderation stored by another exchange, and the update loop's own writes (a community edit is queued
//   in memory and persisted by the next update cycle). When that transaction is rolled back (here: the
//   parked comment's own gate rejects it), those writes are discarded too, after their publishers were
//   told they succeeded.
//
// The gate now runs on a read-back of the row before the insert transaction opens, and that transaction
// closes synchronously. These cases park the store at its gate and check that nothing is lost.
//
// The store is parked deterministically. The first calculateIpfsCidV0 call after insertComments is the
// gate's hash of the stored comment row, and the first _validateSignatureOfPKCRecord call after
// insertCommentEdits is the gate's verification of the stored author edit; the DB read in between is
// synchronous, so the mocks park exactly those calls. Failing exchanges are handed straight to the
// community's pubsub handler so the test can await their catch block.
//
// describeSkipIfRpc: spies on the LocalCommunity's DB handler and calls its pubsub handler in this
// process, which an RPC client cannot reach.
import { it, expect, beforeAll, afterAll, vi } from "vitest";

const { storeGate } = vi.hoisted(() => {
    const storeGate = {
        armed: undefined as "comment" | "authorEdit" | undefined,
        onEntered: undefined as (() => void) | undefined,
        held: undefined as Promise<void> | undefined,
        async passThrough(kind: "comment" | "authorEdit"): Promise<void> {
            if (storeGate.armed !== kind) return;
            storeGate.armed = undefined;
            storeGate.onEntered?.();
            await storeGate.held;
        }
    };
    return { storeGate };
});
vi.mock("../../../../dist/node/util.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../../dist/node/util.js")>();
    return {
        ...actual,
        calculateIpfsCidV0: async (...args: Parameters<typeof actual.calculateIpfsCidV0>) => {
            await storeGate.passThrough("comment");
            return actual.calculateIpfsCidV0(...args);
        }
    };
});
vi.mock("../../../../dist/node/signer/signatures.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../../dist/node/signer/signatures.js")>();
    return {
        ...actual,
        _validateSignatureOfPKCRecord: async (...args: Parameters<typeof actual._validateSignatureOfPKCRecord>) => {
            await storeGate.passThrough("authorEdit");
            return actual._validateSignatureOfPKCRecord(...args);
        }
    };
});

import * as cborg from "cborg";
import Logger from "@pkcprotocol/pkc-logger";
import {
    mockPKC,
    generateMockPost,
    generateMockComment,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    publishWithExpectedResult
} from "../../../../dist/node/test/test-util.js";
import { _signPubsubMsg } from "../../../../dist/node/signer/signatures.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";

import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type { IpfsHttpClientPubsubMessage } from "../../../../dist/node/types.js";
import type { ChallengeRequestMessageType } from "../../../../dist/node/pubsub-messages/types.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";

// Bounded so a step that never happens fails its test with the step's name instead of the runner's timeout
const STEP_TIMEOUT_MS = 30_000;
const withinStepTimeout = <T>(promise: Promise<T>, step: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for: ${step}`)), STEP_TIMEOUT_MS);
        promise.then(
            (value) => (clearTimeout(timer), resolve(value)),
            (error) => (clearTimeout(timer), reject(error))
        );
    });

// Settles to the error (or undefined) so a rejection while the test is still busy is not unhandled
const settledOutcome = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
        (): unknown => undefined,
        (error: unknown) => error
    );

const waitUntil = async (predicate: () => Promise<boolean>, step: string): Promise<void> => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${step}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

type ParkedStore = { entered: Promise<void>; release: () => void; reject: (error: Error) => void; disarm: () => void };

// Parks the next comment or author-edit store at its verbatim gate, right after the gate's insert
function parkNextStore(community: LocalCommunity, kind: "comment" | "authorEdit"): ParkedStore {
    let release!: () => void;
    let reject!: (error: Error) => void;
    storeGate.held = new Promise<void>((resolve, rejectHeld) => ((release = resolve), (reject = rejectHeld)));
    storeGate.held.catch(() => {}); // only the parked store awaits it
    const entered = new Promise<void>((resolve) => (storeGate.onEntered = resolve));
    const insertMethod = kind === "comment" ? "insertComments" : "insertCommentEdits";
    const original = community._dbHandler[insertMethod].bind(community._dbHandler) as (...args: unknown[]) => void;
    const insertSpy = vi.spyOn(community._dbHandler, insertMethod).mockImplementation(((...args: unknown[]) => {
        original(...args);
        insertSpy.mockRestore();
        storeGate.armed = kind;
    }) as never);
    const disarm = () => {
        insertSpy.mockRestore();
        storeGate.armed = undefined;
        release();
    };
    return { entered: withinStepTimeout(entered, `the ${kind} store to park at its verbatim gate`), release, reject, disarm };
}

// Private on Publication; reached the same way duplicate-challenge-delivery.publish.test.ts reaches the pubsub handler
type PublicationRequestInternals = {
    _signAndValidateChallengeRequestBeforePublishing: (
        toSignMsg: Omit<ChallengeRequestMessageType, "signature">,
        signer: SignerType
    ) => Promise<ChallengeRequestMessageType>;
    _generateChallengeRequestToPublish: (
        providerUrl: string,
        acceptedChallengeTypes: string[] | undefined
    ) => Promise<ChallengeRequestMessageType>;
};

type FailingExchange = {
    name: string;
    // Builds a request that makes handleChallengeRequest throw, so handleChallengeExchange's catch runs
    signRequest: (
        requestWithoutSignature: Omit<ChallengeRequestMessageType, "signature">,
        signer: SignerType
    ) => Promise<ChallengeRequestMessageType>;
};

const signRequest = (request: Omit<ChallengeRequestMessageType, "signature">, signer: SignerType) =>
    _signPubsubMsg({
        signedPropertyNames: <ChallengeRequestMessageType["signature"]["signedPropertyNames"]>Object.keys(request),
        msg: request,
        signer,
        log: Logger({ namespace: "pkc-js:test:concurrent-exchange-rollback" })
    });

const failingExchanges: FailingExchange[] = [
    {
        // run 39235375790: throws on the signature check
        name: "a request with a field outside signature.signedPropertyNames",
        signRequest: async (request, signer) => ({ ...request, extraProp: 1234, signature: await signRequest(request, signer) })
    },
    {
        // run 39240773267: correctly signed, but the ciphertext does not decrypt (URIError out of decryptStringAesGcm)
        name: "a request whose encrypted publication cannot be decrypted",
        signRequest: async (request, signer) => {
            const tampered = {
                ...request,
                encrypted: { ...request.encrypted, ciphertext: request.encrypted.ciphertext.map((byte) => byte ^ 0xff) }
            };
            return { ...tampered, signature: await signRequest(tampered, signer) };
        }
    }
];

describeSkipIfRpc("Issue #417: a failing challenge exchange during another exchange's insert", () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let basePost: Comment;
    let authorSigner: SignerType;
    let moderatorSigner: SignerType;
    let adminSigner: SignerType;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = <LocalCommunity>await createSubWithNoChallenge({}, pkc);
        authorSigner = await pkc.createSigner();
        moderatorSigner = await pkc.createSigner();
        adminSigner = await pkc.createSigner();
        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" }, [adminSigner.address]: { role: "admin" } } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        basePost = await publishRandomPost({ communityAddress: community.address, pkc, postProps: { signer: authorSigner } });
    });

    afterAll(async () => {
        storeGate.armed = undefined;
        await community.delete();
        await pkc.destroy();
    });

    async function failingChallengeRequest(failingExchange: FailingExchange): Promise<IpfsHttpClientPubsubMessage> {
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        await post._initCommunity();
        const internals = post as unknown as PublicationRequestInternals;
        internals._signAndValidateChallengeRequestBeforePublishing = failingExchange.signRequest;
        const request = await internals._generateChallengeRequestToPublish("in-process", undefined);
        return <IpfsHttpClientPubsubMessage>(<unknown>{ data: cborg.encode(request) });
    }

    type DirectVictim = {
        name: string;
        kind: "comment" | "authorEdit";
        create: () => Promise<Comment | Awaited<ReturnType<PKC["createCommentEdit"]>>>;
        isStored: (publication: Comment | Awaited<ReturnType<PKC["createCommentEdit"]>>) => boolean;
    };

    const isCommentStored = (publication: Comment | Awaited<ReturnType<PKC["createCommentEdit"]>>) =>
        Boolean(community._dbHandler.queryComment((publication as Comment).cid!));

    const directVictims: DirectVictim[] = [
        {
            name: "a post",
            kind: "comment",
            create: () => generateMockPost({ communityAddress: community.address, pkc }),
            isStored: isCommentStored
        },
        {
            name: "a reply",
            kind: "comment",
            create: () => generateMockComment(basePost as unknown as CommentIpfsWithCidDefined, pkc),
            isStored: isCommentStored
        },
        {
            name: "a crosspost",
            kind: "comment",
            create: () =>
                generateMockPost({
                    communityAddress: community.address,
                    pkc,
                    postProps: { crosspost: { cid: basePost.cid!, comment: basePost.raw.comment! } }
                }),
            isStored: isCommentStored
        },
        {
            name: "an author comment edit",
            kind: "authorEdit",
            create: () =>
                pkc.createCommentEdit({
                    commentCid: basePost.cid!,
                    communityAddress: community.address,
                    content: `Edited ${Math.random()}`,
                    signer: authorSigner
                }),
            isStored: (publication) => {
                const edit = publication as Awaited<ReturnType<PKC["createCommentEdit"]>>;
                const stored = community._dbHandler.queryLatestAuthorEdit(basePost.cid!, authorSigner.address);
                return stored?.signature.signature === edit.raw.pubsubMessageToPublish!.signature.signature;
            }
        }
    ];

    for (const victim of directVictims) {
        for (const failingExchange of failingExchanges) {
            it(`${victim.name} is stored and accepted when ${failingExchange.name} fails meanwhile`, async () => {
                const parked = parkNextStore(community, victim.kind);
                try {
                    const publication = await victim.create();
                    const published = settledOutcome(publishWithExpectedResult({ publication, expectedChallengeSuccess: true }));

                    await parked.entered;
                    await community.handleChallengeExchange(await failingChallengeRequest(failingExchange));
                    parked.release();

                    const publishError = await withinStepTimeout(published, `${victim.name} to get its challenge verification`);
                    expect(publishError, `${victim.name} must be accepted`).toBeUndefined();
                    expect(victim.isStored(publication), `${victim.name} must still be stored`).toBe(true);
                } finally {
                    parked.disarm();
                }
            });
        }
    }

    type CollateralVictim = {
        name: string;
        create: () => Promise<{
            publication: Parameters<typeof publishWithExpectedResult>[0]["publication"];
            isStored: () => Promise<boolean>;
        }>;
    };

    const collateralVictims: CollateralVictim[] = [
        {
            name: "a vote",
            create: async () => {
                const signer = await pkc.createSigner();
                const vote = await pkc.createVote({ commentCid: basePost.cid!, vote: 1, communityAddress: community.address, signer });
                return { publication: vote, isStored: async () => Boolean(community._dbHandler.queryVote(basePost.cid!, signer.address)) };
            }
        },
        {
            name: "a comment moderation",
            create: async () => {
                const moderation = await pkc.createCommentModeration({
                    communityAddress: community.address,
                    commentCid: basePost.cid!,
                    commentModeration: { reason: `Concurrent moderation ${Math.random()}` },
                    signer: moderatorSigner
                });
                return {
                    publication: moderation,
                    isStored: async () =>
                        community._dbHandler.hasCommentModerationWithSignatureEncoded(
                            moderation.raw.pubsubMessageToPublish!.signature.signature
                        )
                };
            }
        },
        {
            name: "a community edit",
            create: async () => {
                const description = `Concurrent community edit ${Math.random()}`;
                const communityEdit = await pkc.createCommunityEdit({
                    communityAddress: community.address,
                    communityEdit: { description },
                    signer: adminSigner
                });
                return {
                    publication: communityEdit,
                    isStored: async () => (await community._getDbInternalState(false)).description === description
                };
            }
        }
    ];

    for (const victim of collateralVictims) {
        it(`${victim.name} stored during a comment's store stays stored when that comment is rejected`, async () => {
            const parked = parkNextStore(community, "comment");
            try {
                const rejectedComment = await generateMockPost({ communityAddress: community.address, pkc });
                const rejectedOutcome = settledOutcome(
                    publishWithExpectedResult({ publication: rejectedComment, expectedChallengeSuccess: false })
                );

                await parked.entered;
                const { publication, isStored } = await victim.create();
                await withinStepTimeout(
                    publishWithExpectedResult({ publication, expectedChallengeSuccess: true }),
                    `${victim.name} to be accepted`
                );
                // Written inside the parked transaction: this connection already reads it back
                await waitUntil(isStored, `${victim.name} to be written to the DB`);

                // The parked comment's store gate rejects it (before #417 was fixed, this rolled back the open transaction)
                parked.reject(new Error("Test rejects the parked comment at its store gate"));
                expect(await withinStepTimeout(rejectedOutcome, "the parked comment to be rejected")).toBeUndefined();

                expect(await isStored(), `${victim.name} must still be stored`).toBe(true);
            } finally {
                parked.disarm();
            }
        });
    }
});

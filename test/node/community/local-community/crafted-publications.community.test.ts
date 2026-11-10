// Issue #387: publications whose signed bytes the community would change between pubsub verification
// and storage or page generation.
//
// The community verifies an incoming publication as sent, stores a row, and later rebuilds the record
// from that row for the pages and the CommentUpdate. Before this fix, a record that no longer verified
// after that round trip (an `author: {}` that cleanWireAuthor turned into "no author", a lone
// surrogate that SQLite stored as replacement characters) was discovered only when the community
// verified its own next record before publishing it, and from then on every publish cycle failed: the
// board stopped publishing, readers kept the last record with no error, and a restart did not help.
//
// The suite is table-driven: every crafted publication below is published through the real challenge
// flow into its own throwaway community (never the shared signers[0] board, which one such publication
// would have frozen for every other suite) and checked against the invariants a correct community
// upholds: a known-bad shape is rejected with its own reason; anything accepted still verifies and
// hashes to its cid when rebuilt from the row, the community goes on minting records with no error,
// and a reader sees it. The cases run inside ONE test because the runner forces --bail 1, which would
// hide every case after the first broken one; assertions are soft so one run reports everything.
// CRAFTED_CASE=<substring of a case name> runs a single case.
//
// describeSkipIfRpc: the suite reads community._dbHandler and the community's own `error` events, and
// the community-side code under test has to be this build; under RPC the local community runs inside
// the RPC server process from the test server's dist.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import {
    mockPKC,
    mockRemotePKC,
    generateMockPost,
    publishRandomPost,
    createSubWithNoChallenge,
    disableValidationOfSignatureBeforePublishing,
    resolveWhenConditionIsTrue,
    iterateThroughPagesToFindCommentInParentPagesInstance
} from "../../../../dist/node/test/test-util.js";
import { verifyCommentIpfs, verifyCommentPubsubMessage } from "../../../../dist/node/signer/signatures.js";
import { deriveCommentIpfsFromCommentTableRow } from "../../../../dist/node/runtime/node/util.js";
import { calculateIpfsCidV0 } from "../../../../dist/node/util.js";
import { messages } from "../../../../dist/node/errors.js";
import Logger from "@pkcprotocol/pkc-logger";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { LONE_SURROGATE, resignVerbatim } from "../../../helpers/resign-verbatim.js";
import type { WirePublication } from "../../../helpers/resign-verbatim.js";

import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";
import type Publication from "../../../../dist/node/publications/publication.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommentPubsubMessagePublication } from "../../../../dist/node/publications/comment/types.js";
import type { DecryptedChallengeVerificationMessageType } from "../../../../dist/node/pubsub-messages/types.js";

const log = Logger({ namespace: "pkc-js:test:crafted-publications" });

type RemoteCommunityInstance = Awaited<ReturnType<PKC["createCommunity"]>>;

function errorCode(e: Error): string {
    return (e as PKCError).code ?? e.name;
}

// ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SIGNATURE and ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID wrap the
// verification result that failed; surface its reason next to the code.
function errorSummary(e: Error): string {
    const details = (e as PKCError).details as { validation?: { reason?: string } } | undefined;
    const reason = details?.validation?.reason;
    return reason ? `${errorCode(e)} (${reason})` : errorCode(e);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${what}`)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function publishAndAwaitVerification(publication: Publication): Promise<{
    verification: DecryptedChallengeVerificationMessageType;
    clientErrors: Error[];
}> {
    const clientErrors: Error[] = [];
    publication.on("error", (e) => clientErrors.push(e));
    const verificationPromise = new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
        publication.once("challengeverification", resolve)
    );
    await publication.publish();
    const verification = await withTimeout(verificationPromise, 60_000, "challengeverification");
    return { verification, clientErrors };
}

type Expected =
    | { outcome: "rejected"; reason: messages } // the community answers challengeSuccess: false with this reason
    | { outcome: "accepted" } // stored verbatim; every invariant below must hold
    | { outcome: "unsendable" }; // cannot even be signed as a complete record; rejected on receipt

type CraftedCase = {
    name: string;
    kind: "comment" | "commentEdit" | "commentModeration" | "vote" | "communityEdit";
    // Mutates the pkc-js-signed wire publication in place; it is re-signed verbatim afterwards
    craft: (publication: WirePublication) => void;
    expected: Expected;
    // Community configuration the case needs, applied before the community starts
    setup?: (community: LocalCommunity) => Promise<void>;
};

// FlairSchema is a looseObject, so an unknown key inside a flair must survive the store's .strip() parse.
// Post flairs have to be enabled and allowlisted, and the allowlist match is a deep equality, so the
// allowlist carries the same unknown key.
const flairWithUnknownKey = { text: "crafted", unknownKey: { nested: true } };
const allowPostFlairs = async (community: LocalCommunity) => {
    await community.edit({ features: { postFlairs: true }, flairs: { post: [flairWithUnknownKey] } });
};

const craftedCases: CraftedCase[] = [
    {
        name: "comment with author: {} (the #387 report)",
        kind: "comment",
        craft: (p) => {
            p.author = {};
        },
        expected: { outcome: "rejected", reason: messages.ERR_PUBLICATION_AUTHOR_IS_AN_EMPTY_OBJECT }
    },
    {
        name: "comment with an empty object nested in author",
        kind: "comment",
        craft: (p) => {
            p.author = { displayName: "nested", extra: {} };
        },
        expected: { outcome: "accepted" }
    },
    {
        name: "comment with an extra signed top-level prop whose value is {}",
        kind: "comment",
        craft: (p) => {
            p.extraProp = {};
        },
        expected: { outcome: "accepted" }
    },
    {
        name: "comment with a lone surrogate in content (TEXT column)",
        kind: "comment",
        craft: (p) => {
            p.content = `before ${LONE_SURROGATE} after`;
        },
        expected: { outcome: "rejected", reason: messages.ERR_PUBLICATION_HAS_MALFORMED_UNICODE_STRING }
    },
    {
        // A JSON column would have kept it, but the rule is about the signature: cborg never covered the
        // string as sent, so it is rejected wherever it sits.
        name: "comment with a lone surrogate in author.displayName (JSON column)",
        kind: "comment",
        craft: (p) => {
            p.author = { displayName: `name ${LONE_SURROGATE}` };
        },
        expected: { outcome: "rejected", reason: messages.ERR_PUBLICATION_HAS_MALFORMED_UNICODE_STRING }
    },
    {
        name: "comment with an extra signed prop named __proto__",
        kind: "comment",
        craft: (p) => {
            // defineProperty makes an own property; the literal `__proto__:` syntax would set the prototype
            Object.defineProperty(p, "__proto__", { value: { crafted: true }, enumerable: true, configurable: true, writable: true });
        },
        expected: { outcome: "unsendable" }
    },
    {
        name: "comment with an empty title string",
        kind: "comment",
        craft: (p) => {
            p.title = "";
        },
        expected: { outcome: "accepted" }
    },
    {
        name: "comment edit with author: {}",
        kind: "commentEdit",
        craft: (p) => {
            p.author = {};
        },
        expected: { outcome: "rejected", reason: messages.ERR_PUBLICATION_AUTHOR_IS_AN_EMPTY_OBJECT }
    },
    {
        name: "comment edit with a lone surrogate in content",
        kind: "commentEdit",
        craft: (p) => {
            p.content = `edited ${LONE_SURROGATE}`;
        },
        expected: { outcome: "rejected", reason: messages.ERR_PUBLICATION_HAS_MALFORMED_UNICODE_STRING }
    },
    {
        name: "comment moderation with author: {}",
        kind: "commentModeration",
        craft: (p) => {
            p.author = {};
        },
        expected: { outcome: "rejected", reason: messages.ERR_PUBLICATION_AUTHOR_IS_AN_EMPTY_OBJECT }
    },
    {
        // A vote is never republished under the author's signature, so a changed byte could not have
        // frozen the board; the rule still applies uniformly through the shared validation.
        name: "vote with author: {}",
        kind: "vote",
        craft: (p) => {
            p.author = {};
        },
        expected: { outcome: "rejected", reason: messages.ERR_PUBLICATION_AUTHOR_IS_AN_EMPTY_OBJECT }
    },
    {
        name: "vote with a lone surrogate in author.displayName",
        kind: "vote",
        craft: (p) => {
            p.author = { displayName: `voter ${LONE_SURROGATE}` };
        },
        expected: { outcome: "rejected", reason: messages.ERR_PUBLICATION_HAS_MALFORMED_UNICODE_STRING }
    },
    {
        // Same for a community edit: its fields land in the record the community signs itself
        name: "community edit with author: {}",
        kind: "communityEdit",
        craft: (p) => {
            p.author = {};
        },
        expected: { outcome: "rejected", reason: messages.ERR_PUBLICATION_AUTHOR_IS_AN_EMPTY_OBJECT }
    },
    {
        name: "community edit with a lone surrogate in the description",
        kind: "communityEdit",
        craft: (p) => {
            p.communityEdit = { description: `described ${LONE_SURROGATE}` };
        },
        expected: { outcome: "rejected", reason: messages.ERR_PUBLICATION_HAS_MALFORMED_UNICODE_STRING }
    },
    {
        name: "comment with a flair carrying an unknown key",
        kind: "comment",
        craft: (p) => {
            p.flairs = [flairWithUnknownKey];
        },
        expected: { outcome: "accepted" },
        setup: allowPostFlairs
    },
    {
        name: "comment edit with a flair carrying an unknown key",
        kind: "commentEdit",
        craft: (p) => {
            p.flairs = [flairWithUnknownKey];
        },
        expected: { outcome: "accepted" },
        setup: allowPostFlairs
    }
];

describeSkipIfRpc("Issue #387: crafted publications are rejected or stored verbatim, and the board keeps publishing", () => {
    let pkc: PKC;
    let remotePkc: PKC;
    // Each case stops its community and parks it here; afterAll deletes them all at once. On Windows
    // every delete() sleeps 10s before removing the DB directory, so deleting per case inside the single
    // `it` costs 16 x 10s and blows the 160s test timeout; one parallel sweep costs 10s total.
    const communitiesToDelete: LocalCommunity[] = [];

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await Promise.all(communitiesToDelete.map((community) => community.delete()));
        await remotePkc.destroy();
        await pkc.destroy();
    });

    const selectedCases = craftedCases.filter((c) => !process.env.CRAFTED_CASE || c.name.includes(process.env.CRAFTED_CASE));

    it("every crafted publication is either rejected or stored so the board keeps publishing", async () => {
        for (const crafted of selectedCases) {
            const tag = (what: string) => `[${crafted.name}] ${what}`;
            const community = <LocalCommunity>await createSubWithNoChallenge({}, pkc);
            const communityErrors: Error[] = [];
            community.on("error", (e) => communityErrors.push(e));
            let remoteCommunity: RemoteCommunityInstance | undefined;
            try {
                const moderatorSigner = await pkc.createSigner();
                if (crafted.kind === "commentModeration")
                    await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
                if (crafted.setup) await crafted.setup(community);
                await community.start();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

                // A valid post for the edit and moderation cases to target; its record is published before they go out
                let targetPost: Comment | undefined;
                if (crafted.kind !== "comment" && crafted.kind !== "communityEdit") {
                    const updatedAtBeforePost = community.updatedAt!;
                    targetPost = await publishRandomPost({ communityAddress: community.address, pkc });
                    await resolveWhenConditionIsTrue({
                        toUpdate: community,
                        predicate: async () => community.updatedAt! > updatedAtBeforePost
                    });
                }

                // Build the publication the way pkc-js would, then craft and re-sign it verbatim
                const editContent = `edited ${Date.now()}`;
                const newDescription = `described ${Date.now()}`;
                const createPublication = async (): Promise<Publication> => {
                    switch (crafted.kind) {
                        case "comment":
                            return generateMockPost({ communityAddress: community.address, pkc });
                        case "commentEdit":
                            return pkc.createCommentEdit({
                                commentCid: targetPost!.cid!,
                                communityAddress: community.address,
                                content: editContent,
                                signer: targetPost!.signer!
                            });
                        case "commentModeration":
                            return pkc.createCommentModeration({
                                commentCid: targetPost!.cid!,
                                communityAddress: community.address,
                                commentModeration: { pinned: true },
                                signer: moderatorSigner
                            });
                        case "vote":
                            return pkc.createVote({
                                commentCid: targetPost!.cid!,
                                communityAddress: community.address,
                                vote: 1,
                                signer: moderatorSigner
                            });
                        case "communityEdit":
                            return pkc.createCommunityEdit({
                                communityAddress: community.address,
                                communityEdit: { description: newDescription },
                                signer: community.signer
                            });
                    }
                };
                const publication = await createPublication();
                if (!publication.raw.pubsubMessageToPublish) {
                    await publication._initCommunity();
                    await publication._signPublicationWithCommunityFields();
                }
                const wire = <WirePublication>structuredClone(publication.raw.pubsubMessageToPublish!);
                crafted.craft(wire);
                await resignVerbatim(wire, publication.signer!);
                publication.raw.pubsubMessageToPublish = <typeof publication.raw.pubsubMessageToPublish>(<unknown>wire);
                disableValidationOfSignatureBeforePublishing(publication);

                if (crafted.kind === "comment") {
                    const asSent = await verifyCommentPubsubMessage({
                        comment: <CommentPubsubMessagePublication>(<unknown>wire),
                        resolveAuthorNames: false,
                        clientsManager: pkc._clientsManager
                    });
                    if (!asSent.valid) {
                        // The community rejects a record that does not verify on receipt, so it never reaches storage
                        log(crafted.name, "cannot be sent as a verified record, community will reject it:", JSON.stringify(asSent));
                        expect.soft(crafted.expected.outcome, tag(`unsendable: ${JSON.stringify(asSent)}`)).toBe("unsendable");
                        continue;
                    }
                }

                const updatedAtBeforePublish = community.updatedAt!;
                const { verification, clientErrors } = await publishAndAwaitVerification(publication);
                log(crafted.name, "challengeverification", {
                    challengeSuccess: verification.challengeSuccess,
                    reason: verification.reason,
                    cid: verification.commentUpdate?.cid,
                    clientErrors: clientErrors.map(errorSummary)
                });

                if (!verification.challengeSuccess) {
                    // Nothing stored, the board untouched; the publisher gets the specific reason
                    expect.soft(crafted.expected.outcome, tag(`rejected with reason: ${verification.reason}`)).toBe("rejected");
                    if (crafted.expected.outcome === "rejected")
                        expect.soft(verification.reason, tag("rejection reason")).toBe(crafted.expected.reason);
                    expect
                        .soft(
                            community._dbHandler.hasCommentWithSignatureEncoded(wire.signature.signature),
                            tag("rejected publication must not be stored")
                        )
                        .toBe(false);
                    continue;
                }
                expect.soft(crafted.expected.outcome, tag("accepted by the community")).toBe("accepted");

                // Invariant 1 (comments): the stored record still verifies and hashes to the cid it was accepted under
                if (crafted.kind === "comment") {
                    const cid = verification.commentUpdate!.cid;
                    const row = community._dbHandler.queryComment(cid);
                    expect(row, tag("accepted comment must be in the DB")).toBeTruthy();
                    const storedComment = deriveCommentIpfsFromCommentTableRow(row!);
                    const storedValidity = await verifyCommentIpfs({
                        comment: storedComment,
                        resolveAuthorNames: false,
                        calculatedCommentCid: cid,
                        clientsManager: pkc._clientsManager
                    });
                    expect
                        .soft(
                            storedValidity.valid,
                            tag(`stored comment must verify against its own signature: ${JSON.stringify(storedValidity)}`)
                        )
                        .toBe(true);
                    const storedCid = await calculateIpfsCidV0(deterministicStringify(storedComment)!);
                    expect.soft(storedCid, tag("stored comment must still hash to the cid the community accepted it under")).toBe(cid);
                }

                // Invariant 2: the next sync publishes a record and emits no error. The publish loop can be
                // behind a repo GC, so this is a generous wait.
                const nextRecord = resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.updatedAt! > updatedAtBeforePublish
                });
                const syncError = resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => communityErrors.length > 0,
                    eventName: "error"
                });
                try {
                    await withTimeout(Promise.race([nextRecord, syncError]), 90_000, "the community's next publish cycle");
                } catch (e) {
                    log(crafted.name, (e as Error).message);
                }
                const syncErrors = communityErrors.map(errorSummary);
                log(
                    crafted.name,
                    "community errors after acceptance:",
                    syncErrors,
                    "record advanced:",
                    community.updatedAt! > updatedAtBeforePublish
                );
                expect.soft(syncErrors, tag("community must emit no error after accepting a publication")).toEqual([]);
                expect
                    .soft(
                        community.updatedAt! > updatedAtBeforePublish,
                        tag("community must publish a new record after accepting a publication")
                    )
                    .toBe(true);

                // Invariant 3: a reader sees the accepted publication
                remoteCommunity = await remotePkc.createCommunity({ address: community.address });
                const readerErrors: Error[] = [];
                remoteCommunity.on("error", (e) => readerErrors.push(e));
                await remoteCommunity.update();
                if (crafted.kind === "communityEdit") {
                    try {
                        await withTimeout(
                            resolveWhenConditionIsTrue({
                                toUpdate: remoteCommunity,
                                predicate: async () => remoteCommunity!.description === newDescription
                            }),
                            20_000,
                            "the reader to see the community edit applied"
                        );
                    } catch (e) {
                        log(crafted.name, (e as Error).message);
                    }
                    expect
                        .soft(remoteCommunity.description, tag("reader must see the accepted community edit applied"))
                        .toBe(newDescription);
                } else if (crafted.kind === "comment") {
                    const cid = verification.commentUpdate!.cid;
                    let postInReaderPages: unknown;
                    try {
                        await withTimeout(
                            resolveWhenConditionIsTrue({
                                toUpdate: remoteCommunity,
                                predicate: async () => {
                                    if (typeof remoteCommunity!.updatedAt !== "number") return false;
                                    postInReaderPages = await iterateThroughPagesToFindCommentInParentPagesInstance(
                                        cid,
                                        remoteCommunity!.posts
                                    );
                                    return Boolean(postInReaderPages);
                                }
                            }),
                            20_000,
                            "the reader to find the post in community.posts"
                        );
                    } catch (e) {
                        log(crafted.name, (e as Error).message);
                    }
                    expect
                        .soft(
                            postInReaderPages,
                            tag(
                                `reader must find the accepted post in community.posts; reader errors: ${JSON.stringify(readerErrors.map(errorSummary))}`
                            )
                        )
                        .toBeTruthy();
                } else {
                    const readerComment = await remotePkc.createComment({ cid: targetPost!.cid! });
                    const readerCommentErrors: Error[] = [];
                    readerComment.on("error", (e) => readerCommentErrors.push(e));
                    const applied = () =>
                        crafted.kind === "commentEdit"
                            ? readerComment.content === editContent
                            : crafted.kind === "vote"
                              ? readerComment.upvoteCount === 1
                              : readerComment.pinned === true;
                    await readerComment.update();
                    try {
                        await withTimeout(
                            resolveWhenConditionIsTrue({ toUpdate: readerComment, predicate: async () => applied() }),
                            20_000,
                            "the reader to see the publication applied"
                        );
                    } catch (e) {
                        log(crafted.name, (e as Error).message);
                    } finally {
                        await readerComment.stop();
                    }
                    expect
                        .soft(
                            applied(),
                            tag(
                                `reader must see the accepted publication applied; reader errors: ${JSON.stringify(readerCommentErrors.map(errorSummary))}`
                            )
                        )
                        .toBe(true);
                }
            } finally {
                await remoteCommunity?.stop();
                await community.stop();
                communitiesToDelete.push(community);
            }
        }
    });
});

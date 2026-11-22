// Publishes a comment whose signed record carries an unknown prop under a chosen name, into a community the
// caller owns. Only ever point this at a throwaway community: a poisoned comment published to a shared
// board (signers[*], plebbit.bso) would break every other running suite that loads it.
import { generateMockPost, generateMockComment, disableValidationOfSignatureBeforePublishing } from "../../dist/node/test/test-util.js";
import { resignVerbatim } from "./resign-verbatim.js";
import type { WirePublication } from "./resign-verbatim.js";
import type { PKC } from "../../dist/node/pkc/pkc.js";
import type { Comment } from "../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../dist/node/publications/comment/types.js";
import { HOSTILE_VALUE } from "./hostile-props.js";

export type PublishedComment = {
    name: string;
    accepted: boolean;
    cid?: string;
    reason?: string;
    publisher: Comment;
    publisherErrors: Error[];
};

export async function publishPoisonedComment({
    pkc,
    communityAddress,
    parent,
    name,
    value,
    inAuthor
}: {
    pkc: PKC;
    communityAddress: string;
    parent?: Comment; // a reply when given, a post otherwise
    name: string;
    value?: unknown;
    inAuthor?: boolean; // plant the name inside the record's author object instead of at the top level
}): Promise<PublishedComment> {
    const publication = parent
        ? await generateMockComment(<CommentIpfsWithCidDefined>(<unknown>parent), pkc)
        : await generateMockPost({ communityAddress, pkc });
    if (!publication.raw.pubsubMessageToPublish) {
        await publication._initCommunity();
        await publication._signPublicationWithCommunityFields();
    }
    const wire = <WirePublication>structuredClone(publication.raw.pubsubMessageToPublish!);
    const planted = value === undefined ? (name === "__proto__" ? { polluted: true } : HOSTILE_VALUE) : value;
    // a computed key through a JSON round trip makes "__proto__" an own property, as a wire record has it
    const poisoned = <WirePublication>(
        JSON.parse(
            JSON.stringify(
                inAuthor
                    ? { ...wire, author: { ...(<Record<string, unknown>>wire.author), [name]: planted } }
                    : { ...wire, [name]: planted }
            )
        )
    );
    await resignVerbatim(poisoned, publication.signer!);
    publication.raw.pubsubMessageToPublish = <typeof publication.raw.pubsubMessageToPublish>(<unknown>poisoned);
    disableValidationOfSignatureBeforePublishing(publication);

    const publisherErrors: Error[] = [];
    publication.on("error", (e) => publisherErrors.push(e));
    // A refusal reaches the publisher as a challengeverification, or, when the community lives in an RPC server, can
    // reach it as an error event instead; both end the wait, the second with the error code as the reason
    const verification = new Promise<{ challengeSuccess: boolean; reason?: string; commentUpdate?: { cid: string } }>((resolve) => {
        publication.once("challengeverification", resolve);
        publication.once("error", (e: Error & { code?: string }) => resolve({ challengeSuccess: false, reason: e.code ?? e.message }));
    });
    await publication.publish();
    const v = await verification;
    return { name, accepted: v.challengeSuccess, cid: v.commentUpdate?.cid, reason: v.reason, publisher: publication, publisherErrors };
}

import { v4 as uuidV4 } from "uuid";
import type { CommunityChallengeSetting } from "../../../../community/types.js";
import type { CommentsTableRow, CommentUpdatesTableRowInsert, CommentUpdateType } from "../../../../publications/comment/types.js";
import { messages } from "../../../../errors.js";

export type CommentUpdateToWriteToDbAndPublishToIpfs = {
    newCommentUpdate: CommentUpdateType;
    newCommentUpdateToWriteToDb: CommentUpdatesTableRowInsert;
    localMfsPath: string | undefined;
    pendingApproval: CommentsTableRow["pendingApproval"];
};

export const DUPLICATE_PUBLICATION_ERRORS = new Set<string>([
    messages.ERR_DUPLICATE_COMMENT,
    messages.ERR_DUPLICATE_COMMENT_EDIT,
    messages.ERR_DUPLICATE_COMMENT_MODERATION
]);

export const defaultChallengeQuestionText =
    "What is the answer to this community's challenge? (check community.settings.challenges to see the answer, or set your own challenge)";

export function generateDefaultChallenges(answer?: string): CommunityChallengeSetting[] {
    return [
        {
            name: "question",
            options: {
                question: defaultChallengeQuestionText,
                answer: answer ?? uuidV4()
            }
        }
    ];
}

export function isDefaultChallengeStructure(challenges: CommunityChallengeSetting[] | undefined): boolean {
    if (!challenges || challenges.length !== 1) return false;
    const c = challenges[0];
    return (
        c.name === "question" &&
        c.options?.question === defaultChallengeQuestionText &&
        typeof c.options?.answer === "string" &&
        c.options.answer.length > 0
    );
}

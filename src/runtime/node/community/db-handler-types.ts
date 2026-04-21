import type { CommentsTableRow, CommentUpdatesRow } from "../../../publications/comment/types.js";
import type { SignerType } from "../../../signer/types.js";
import type { CommunityIpfsType } from "../../../community/types.js";

export type PurgedCommentTableRows = {
    commentTableRow: CommentsTableRow;
    commentUpdateTableRow?: Pick<CommentUpdatesRow, "postUpdatesBucket" | "replies">;
};

export type CommentCidWithReplies = Pick<CommentsTableRow, "cid"> & Pick<CommentUpdatesRow, "replies">;

type Features = NonNullable<CommunityIpfsType["features"]>;
type PseudonymityMode = NonNullable<Features["pseudonymityMode"]>;

export type PseudonymityAliasRow = {
    commentCid: CommentsTableRow["cid"];
    aliasPrivateKey: SignerType["privateKey"];
    originalAuthorPublicKey: NonNullable<SignerType["publicKey"]>;
    originalAuthorName: string | null; // the original author's name (e.g., user.bso) if they used one
    mode: PseudonymityMode;
    insertedAt: number;
};

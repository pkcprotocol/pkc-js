import { RemoteCommunity } from "../../community/remote-community.js";
import type { PageIpfs } from "../../pages/types.js";
import type { CommentIpfsWithCidDefined } from "./types.js";
export declare function loadAllPagesUnderCommunityToFindComment(opts: {
    commentCidToFind: CommentIpfsWithCidDefined["cid"];
    community: RemoteCommunity;
    postCid?: CommentIpfsWithCidDefined["cid"];
    parentCid?: CommentIpfsWithCidDefined["cid"];
    signal?: AbortSignal;
}): Promise<PageIpfs["comments"][number] | undefined>;

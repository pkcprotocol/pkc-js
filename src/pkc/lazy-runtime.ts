// Single lazy barrel for the "heavy" runtime that RPC-only consumers never touch on a bare import
// (issue #120, Lever B). pkc.ts and pkc-with-rpc-client.ts dynamic-import EVERYTHING heavy through
// this one module instead of importing publications/comment/signer/community modules from many
// separate `await import()` sites.
//
// Why one barrel and not many direct dynamic imports: rolldown's automatic code-splitting hoists a
// module shared by two *different* lazy chunks (e.g. pages/pages.js, reached from both the comment
// chunk and the remote-community chunk) into their nearest common chunk — which turns out to be the
// shared static chunk that also holds src/util.js, so it ends up in every entry's static closure and
// defeats the laziness. Funnelling all the heavy imports through this single dynamic entry point
// means the whole subtree (comment -> typestub-ipfs-only-hash, signer/util -> @libp2p/peer-id, pages,
// the community classes) is reachable through exactly one dynamic import, so rolldown keeps it in one
// lazy chunk that no entry references statically. config/verify-bundle.js asserts this holds.
//
// It costs nothing extra at runtime: the first create*/createCommunity call loads the chunk once, and
// materializing a community needs the whole subtree anyway.
export { Comment } from "../publications/comment/comment.js";
export { default as Vote } from "../publications/vote/vote.js";
export { CommentEdit } from "../publications/comment-edit/comment-edit.js";
export { CommentModeration } from "../publications/comment-moderation/comment-moderation.js";
export { default as CommunityEdit } from "../publications/community-edit/community-edit.js";
export { RemoteCommunity } from "../community/remote-community.js";
export { RpcRemoteCommunity } from "../community/rpc-remote-community.js";
export { RpcLocalCommunity } from "../community/rpc-local-community.js";
export { createSigner } from "../signer/index.js";
export { verifyCommentIpfs, verifyCommentUpdate } from "../signer/signatures.js";
export { cleanWireAuthor, normalizeCreatePublicationAuthor } from "../publications/publication-author.js";
export { extractCommunityRuntimeFieldsFromParsedPages } from "../pages/util.js";

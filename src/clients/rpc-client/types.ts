import { z } from "zod";
import {
    RpcAuthorNameParamSchema,
    RpcCidParamSchema,
    RpcFetchCidParamSchema,
    RpcCommentRepliesPageParamSchema,
    RpcCommunityIdentifierParamSchema,
    RpcCommunityPageParamSchema,
    RpcEditCommunityParamSchema,
    RpcPublishChallengeAnswersParamSchema,
    RpcResolveAuthorNameResultSchema,
    RpcFetchCidResultSchema,
    RpcCommunityStartedResultSchema,
    RpcSuccessResultSchema,
    RpcSubscriptionIdResultSchema,
    RpcExportCommunityParamSchema,
    RpcCancelExportParamSchema,
    RpcExportCommunityResultSchema,
    RpcExportschangeResultSchema,
    RpcExportCommunityModLogsParamSchema,
    RpcExportCommunityModLogsResultSchema
} from "./schema.js";
import type { PageIpfs, ModQueuePageIpfs } from "../../pages/types.js";
import type { PageRuntimeFields } from "../../pages/util.js";

// Param types
export type CidRpcParam = z.infer<typeof RpcCidParamSchema>;
export type FetchCidRpcParam = z.infer<typeof RpcFetchCidParamSchema>;
export type CommunityIdentifierRpcParam = z.infer<typeof RpcCommunityIdentifierParamSchema>;
export type AuthorNameRpcParam = z.infer<typeof RpcAuthorNameParamSchema>;
export type CommentPageRpcParam = z.infer<typeof RpcCommentRepliesPageParamSchema>;
export type CommunityPageRpcParam = z.infer<typeof RpcCommunityPageParamSchema>;
export type EditCommunityRpcParam = z.infer<typeof RpcEditCommunityParamSchema>;
export type PublishChallengeAnswersRpcParam = z.infer<typeof RpcPublishChallengeAnswersParamSchema>;
export type ExportCommunityRpcParam = z.infer<typeof RpcExportCommunityParamSchema>;
export type CancelExportRpcParam = z.infer<typeof RpcCancelExportParamSchema>;
export type ExportCommunityModLogsRpcParam = z.infer<typeof RpcExportCommunityModLogsParamSchema>;

// Result types (shared between RPC client and server)
export type RpcResolveAuthorNameResult = z.infer<typeof RpcResolveAuthorNameResultSchema>;
export type RpcFetchCidResult = z.infer<typeof RpcFetchCidResultSchema>;
export type RpcCommunityStartedResult = z.infer<typeof RpcCommunityStartedResultSchema>;
export type RpcSuccessResult = z.infer<typeof RpcSuccessResultSchema>;
export type RpcSubscriptionIdResult = z.infer<typeof RpcSubscriptionIdResultSchema>;
export type RpcExportCommunityResult = z.infer<typeof RpcExportCommunityResultSchema>;
export type RpcExportschangeResult = z.infer<typeof RpcExportschangeResultSchema>;
export type RpcExportCommunityModLogsResult = z.infer<typeof RpcExportCommunityModLogsResultSchema>;

// Re-export existing complex types used as RPC return values
export type { RpcInternalCommunityRecordBeforeFirstUpdateType, RpcLocalCommunityUpdateResultType } from "../../community/types.js";

// Page result types
export type RpcCommentPageResult = { page: PageIpfs; runtimeFields?: PageRuntimeFields };
export type RpcCommunityPageResult = { page: PageIpfs | ModQueuePageIpfs; runtimeFields?: PageRuntimeFields };

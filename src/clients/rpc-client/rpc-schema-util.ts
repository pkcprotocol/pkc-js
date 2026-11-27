import { z } from "zod";
import { PKCError } from "../../pkc-error.js";
import {
    RpcAuthorNameParamSchema,
    RpcCidParamSchema,
    RpcFetchCidParamSchema,
    RpcCommentRepliesPageParamSchema,
    RpcEditCommunityParamSchema,
    RpcPublishChallengeAnswersParamSchema,
    RpcCommunityIdentifierParamSchema,
    RpcCommunityPageParamSchema,
    RpcUnsubscribeParamSchema,
    RpcResolveAuthorNameResultSchema,
    RpcFetchCidResultSchema,
    RpcSuccessResultSchema,
    RpcSubscriptionIdResultSchema,
    RpcExportCommunityParamSchema,
    RpcCancelExportParamSchema,
    RpcExportCommunityResultSchema,
    RpcExportschangeResultSchema,
    RpcExportCommunityModLogsParamSchema,
    RpcGetLogsParamSchema,
    LogQuerySchema,
    RpcGetLogsResultSchema,
    RpcExportCommunityModLogsResultSchema,
    RpcPublishAnchorRecordParamSchema,
    RpcAnchorPublishPreparationResultSchema,
    RpcPublishedAnchorRecordResultSchema,
    RpcPublishCommunityListParamSchema,
    RpcPublishCommunityListResultSchema,
    RpcFetchCommunityListParamSchema,
    RpcFetchCommunityListResultSchema
} from "./schema.js";

// Param parsers — all use .loose() so newer clients can send extra fields
export const parseRpcCidParam = (params: unknown) => RpcCidParamSchema.loose().parse(params);
export const parseRpcFetchCidParam = (params: unknown) => RpcFetchCidParamSchema.loose().parse(params);
export const parseRpcCommunityIdentifierParam = (params: unknown) => RpcCommunityIdentifierParamSchema.loose().parse(params);
export const parseRpcAuthorNameParam = (params: unknown) => RpcAuthorNameParamSchema.loose().parse(params);
export const parseRpcCommunityPageParam = (params: unknown) => RpcCommunityPageParamSchema.loose().parse(params);
export const parseRpcCommentRepliesPageParam = (params: unknown) => RpcCommentRepliesPageParamSchema.loose().parse(params);
export const parseRpcEditCommunityParam = (params: unknown) => RpcEditCommunityParamSchema.loose().parse(params);
export const parseRpcPublishChallengeAnswersParam = (params: unknown) => RpcPublishChallengeAnswersParamSchema.loose().parse(params);
export const parseRpcUnsubscribeParam = (params: unknown) => RpcUnsubscribeParamSchema.loose().parse(params);

// Result parsers — all use .loose() so newer servers can send extra fields
export const parseRpcResolveAuthorNameResult = (result: unknown) => RpcResolveAuthorNameResultSchema.loose().parse(result);
export const parseRpcFetchCidResult = (result: unknown) => RpcFetchCidResultSchema.loose().parse(result);
export const parseRpcSuccessResult = (result: unknown) => RpcSuccessResultSchema.loose().parse(result);
export const parseRpcSubscriptionIdResult = (result: unknown) => RpcSubscriptionIdResultSchema.loose().parse(result);

// Delegation setup (#234)
export const parseRpcPublishAnchorRecordParam = (params: unknown) => RpcPublishAnchorRecordParamSchema.loose().parse(params);
export const parseRpcAnchorPublishPreparationResult = (result: unknown) => RpcAnchorPublishPreparationResultSchema.loose().parse(result);
export const parseRpcPublishedAnchorRecordResult = (result: unknown) => RpcPublishedAnchorRecordResultSchema.loose().parse(result);

// CommunityList — wire param/result parsers
export const parseRpcPublishCommunityListParam = (params: unknown) => RpcPublishCommunityListParamSchema.loose().parse(params);
export const parseRpcPublishCommunityListResult = (result: unknown) => RpcPublishCommunityListResultSchema.loose().parse(result);
export const parseRpcFetchCommunityListParam = (params: unknown) => RpcFetchCommunityListParamSchema.loose().parse(params);
export const parseRpcFetchCommunityListResult = (result: unknown) => RpcFetchCommunityListResultSchema.loose().parse(result);

// community.export() — wire param/result parsers
export const parseRpcExportCommunityParam = (params: unknown) => RpcExportCommunityParamSchema.loose().parse(params);
export const parseRpcCancelExportParam = (params: unknown) => RpcCancelExportParamSchema.loose().parse(params);
export const parseRpcExportCommunityResult = (result: unknown) => RpcExportCommunityResultSchema.loose().parse(result);
export const parseRpcExportschangeResult = (result: unknown) => RpcExportschangeResultSchema.loose().parse(result);

// pkc.getLogs() / getLogs RPC method — wire param/result parsers (issue #493). The param parser is NOT loose: an unknown
// key (rpcUrl included) is an ERR_INVALID_LOG_QUERY, see LogQuerySchema
export const parseRpcGetLogsParam = (params: unknown) => RpcGetLogsParamSchema.parse(params);
export function parseLogQueryWithPKCErrorIfItFails(query: unknown): z.output<typeof LogQuerySchema> {
    const parseRes = LogQuerySchema.safeParse(query);
    if (!parseRes.success) throw new PKCError("ERR_INVALID_LOG_QUERY", { zodError: parseRes.error, query });
    return parseRes.data;
}
export const parseRpcGetLogsResult = (result: unknown) => RpcGetLogsResultSchema.loose().parse(result);

// community.exportCommunityModLogs() — wire param/result parsers
export const parseRpcExportCommunityModLogsParam = (params: unknown) => RpcExportCommunityModLogsParamSchema.loose().parse(params);
export const parseRpcExportCommunityModLogsResult = (result: unknown) => RpcExportCommunityModLogsResultSchema.loose().parse(result);

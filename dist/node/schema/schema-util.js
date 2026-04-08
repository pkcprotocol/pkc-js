import { ModQueuePageIpfsSchema, PageIpfsSchema } from "../pages/schema.js";
import { PKCError } from "../pkc-error.js";
import { CommentChallengeRequestToEncryptSchema, CommentIpfsSchema, CommentPubsubMessageWithFlexibleAuthorRefinementSchema, CommentUpdateSchema, CreateCommentOptionsSchema, CreateCommentOptionsWithRefinementSchema } from "../publications/comment/schema.js";
import { DecryptedChallengeAnswerSchema, DecryptedChallengeSchema, DecryptedChallengeVerificationSchema } from "../pubsub-messages/schema.js";
import { CreateNewLocalCommunityUserOptionsSchema, CreateRemoteCommunityFunctionArgumentSchema, CreateRpcCommunityFunctionArgumentSchema, CreateCommunityFunctionArgumentsSchema, RpcRemoteCommunityUpdateEventResultSchema, CommunityEditOptionsSchema, CommunityIpfsSchema } from "../community/schema.js";
import { CidStringSchema } from "./schema.js";
import { RpcCommentEventResultSchema, RpcCommentUpdateResultSchema } from "../clients/rpc-client/schema.js";
import { CreatePKCWsServerOptionsSchema, SetNewSettingsPKCWsServerSchema } from "../rpc/src/schema.js";
import { CommentModerationChallengeRequestToEncryptSchema, CommentModerationPubsubMessagePublicationSchema, CreateCommentModerationOptionsSchema } from "../publications/comment-moderation/schema.js";
import { CreateVoteUserOptionsSchema, VoteChallengeRequestToEncryptSchema, VotePubsubMessagePublicationSchema } from "../publications/vote/schema.js";
import { CommentEditChallengeRequestToEncryptSchema, CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema, CreateCommentEditOptionsSchema } from "../publications/comment-edit/schema.js";
import { PKCUserOptionsSchema } from "../schema.js";
import { CreateCommunityEditPublicationOptionsSchema, CommunityEditPublicationChallengeRequestToEncryptSchema, CommunityEditPubsubMessagePublicationSchema } from "../publications/community-edit/schema.js";
export function parseJsonWithPKCErrorIfFails(x) {
    try {
        return JSON.parse(x);
    }
    catch (e) {
        throw new PKCError("ERR_INVALID_JSON", { error: e, invalidJson: x });
    }
}
export function parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(communityIpfs) {
    const parseRes = CommunityIpfsSchema.loose().safeParse(communityIpfs);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_COMMUNITY_IPFS_SCHEMA", {
            zodError: parseRes.error,
            communityAddress: communityIpfs?.address,
            communityJson: communityIpfs
        });
    else
        return communityIpfs;
}
export function parseCommentIpfsSchemaWithPKCErrorIfItFails(commentIpfsJson) {
    const parseRes = CommentIpfsSchema.loose().safeParse(commentIpfsJson);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_COMMENT_IPFS_SCHEMA", { zodError: parseRes.error, commentIpfsJson });
    else
        return commentIpfsJson;
}
export function parseCommentUpdateSchemaWithPKCErrorIfItFails(commentUpdateJson) {
    const parseRes = CommentUpdateSchema.loose().safeParse(commentUpdateJson);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_COMMENT_UPDATE_SCHEMA", { zodError: parseRes.error, commentUpdateJson });
    else
        return commentUpdateJson;
}
export function parsePageIpfsSchemaWithPKCErrorIfItFails(pageIpfsJson) {
    const parseRes = PageIpfsSchema.safeParse(pageIpfsJson);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_PAGE_IPFS_SCHEMA", { zodError: parseRes.error, pageIpfsJson });
    else
        return pageIpfsJson;
}
export function parseModQueuePageIpfsSchemaWithPKCErrorIfItFails(modQueuePageIpfsJson) {
    const parseRes = ModQueuePageIpfsSchema.safeParse(modQueuePageIpfsJson);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_MODQUEUE_PAGE_IPFS_SCHEMA", { zodError: parseRes.error, modQueuePageIpfsJson });
    else
        return modQueuePageIpfsJson;
}
export function parseDecryptedChallengeWithPKCErrorIfItFails(decryptedChallengeJson) {
    const parseRes = DecryptedChallengeSchema.loose().safeParse(decryptedChallengeJson);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CHALLENGE_DECRYPTED_SCHEMA", { zodError: parseRes.error, decryptedChallengeJson });
    else
        return decryptedChallengeJson;
}
export function parseDecryptedChallengeVerification(decryptedChallengeVerificationJson) {
    const parseRes = DecryptedChallengeVerificationSchema.loose().safeParse(decryptedChallengeVerificationJson);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CHALLENGE_VERIFICATION_DECRYPTED_SCHEMA", {
            zodError: parseRes.error,
            decryptedChallengeVerificationJson
        });
    else
        return decryptedChallengeVerificationJson;
}
export function parseRpcRemoteCommunityUpdateEventWithPKCErrorIfItFails(rpcRemoteCommunity) {
    const parseRes = RpcRemoteCommunityUpdateEventResultSchema.strip().safeParse(rpcRemoteCommunity);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_RPC_REMOTE_COMMUNITY_SCHEMA", {
            zodError: parseRes.error,
            rpcRemoteCommunity
        });
    else
        return rpcRemoteCommunity;
}
export function parseCidStringSchemaWithPKCErrorIfItFails(cidString) {
    try {
        return CidStringSchema.parse(cidString);
    }
    catch (e) {
        throw new PKCError("ERR_INVALID_CID_STRING_SCHEMA", {
            zodError: e,
            cidString
        });
    }
}
export function parseRpcCommentUpdateEventWithPKCErrorIfItFails(updateResult) {
    const parseRes = RpcCommentUpdateResultSchema.safeParse(updateResult);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_RPC_COMMENT_UPDATE_SCHEMA", {
            zodError: parseRes.error,
            updateResult
        });
    else
        return updateResult;
}
export function parseRpcCommentEventWithPKCErrorIfItFails(updateResult) {
    const parseRes = RpcCommentEventResultSchema.safeParse(updateResult);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_RPC_COMMENT_SCHEMA", {
            zodError: parseRes.error,
            updateResult
        });
    else
        return updateResult;
}
export function parseCommunityEditPubsubMessagePublicationSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CommunityEditPubsubMessagePublicationSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_COMMUNITY_EDIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CommunityEditPubsubMessagePublication"
        });
    else
        return args;
}
export function parseCreateCommunityEditPublicationOptionsSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CreateCommunityEditPublicationOptionsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_COMMUNITY_EDIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CreateCommunityEditPublicationOptions"
        });
    else
        return args;
}
export function parseDecryptedChallengeAnswerWithPKCErrorIfItFails(decryptedChallengeAnswers) {
    const parseRes = DecryptedChallengeAnswerSchema.safeParse(decryptedChallengeAnswers);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CHALLENGE_ANSWERS", {
            zodError: parseRes.error,
            challengeAnswers: decryptedChallengeAnswers
        });
    else
        return decryptedChallengeAnswers;
}
export function parseCreatePKCWsServerOptionsSchemaWithPKCErrorIfItFails(options) {
    const parseRes = CreatePKCWsServerOptionsSchema.safeParse(options);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_PKC_WS_SERVER_OPTIONS_SCHEMA", {
            zodError: parseRes.error,
            challengeAnswers: options
        });
    else
        return options;
}
export function parseCommentModerationChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(toEncrypt) {
    const parseRes = CommentModerationChallengeRequestToEncryptSchema.safeParse(toEncrypt);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_COMMENT_MODERATION_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA", {
            zodError: parseRes.error,
            toEncrypt
        });
    else
        return toEncrypt;
}
export function parseCommunityEditChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(toEncrypt) {
    const parseRes = CommunityEditPublicationChallengeRequestToEncryptSchema.safeParse(toEncrypt);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_COMMUNITY_EDIT_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA", {
            zodError: parseRes.error,
            toEncrypt
        });
    else
        return toEncrypt;
}
export function parseCommunityEditOptionsSchemaWithPKCErrorIfItFails(editOptions) {
    const parseRes = CommunityEditOptionsSchema.safeParse(editOptions);
    if (!parseRes.success)
        throw new PKCError("ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA", {
            zodError: parseRes.error,
            editOptions
        });
    else
        return editOptions;
}
export function parseCommentChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(toEncrypt) {
    const parseRes = CommentChallengeRequestToEncryptSchema.loose().safeParse(toEncrypt);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_COMMENT_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA", {
            zodError: parseRes.error,
            toEncrypt
        });
    else
        return toEncrypt;
}
export function parseVoteChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(toEncrypt) {
    const parseRes = VoteChallengeRequestToEncryptSchema.safeParse(toEncrypt);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_VOTE_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA", {
            zodError: parseRes.error,
            toEncrypt
        });
    else
        return toEncrypt;
}
export function parseCommentEditChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(toEncrypt) {
    const parseRes = CommentEditChallengeRequestToEncryptSchema.safeParse(toEncrypt);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_COMMENT_EDIT_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA", {
            zodError: parseRes.error,
            toEncrypt
        });
    else
        return toEncrypt;
}
export function parseCreateNewLocalCommunityUserOptionsSchemaWithPKCErrorIfItFails(options) {
    const parseRes = CreateNewLocalCommunityUserOptionsSchema.safeParse(options);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_NEW_LOCAL_COMMUNITY_USER_OPTIONS", {
            zodError: parseRes.error,
            options
        });
    else
        return options;
}
export function parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails(settings) {
    const parseRes = SetNewSettingsPKCWsServerSchema.safeParse(settings);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_NEW_WS_SERVER_SETTINGS_SCHEMA", {
            zodError: parseRes.error,
            settings
        });
    else
        return settings;
}
export function parseCreateCommentModerationOptionsSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CreateCommentModerationOptionsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_COMMENT_MODERATION_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CreateCommentModerationOptions"
        });
    else
        return args;
}
export function parseCommentModerationPubsubMessagePublicationSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CommentModerationPubsubMessagePublicationSchema.loose().safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_COMMENT_MODERATION_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CommentModerationPubsubMessagePublication"
        });
    else
        return args;
}
export function parseCreateRemoteCommunityFunctionArgumentSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CreateRemoteCommunityFunctionArgumentSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_REMOTE_COMMUNITY_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args
        });
    else
        return args;
}
export function parseCreateVoteOptionsSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CreateVoteUserOptionsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_VOTE_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CreateVoteOptions"
        });
    else
        return args;
}
export function parseVotePubsubMessagePublicationSchemaWithPKCErrorIfItFails(args) {
    const parseRes = VotePubsubMessagePublicationSchema.loose().safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_VOTE_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "VotePubsubMessagePublication"
        });
    else
        return args;
}
export function parseCreateCommentEditOptionsSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CreateCommentEditOptionsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_COMMENT_EDIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CreateCommentEditOptions"
        });
    else
        return args;
}
export function parseCommentEditPubsubMessagePublicationSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_COMMENT_EDIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CommentEditPubsubMessagePublication"
        });
    else
        return args;
}
export function parseCreateCommunityFunctionArgumentsSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CreateCommunityFunctionArgumentsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_COMMUNITY_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args
        });
    else
        return args;
}
export function parsePKCUserOptionsSchemaWithPKCErrorIfItFails(args) {
    // normally we don't change args, but here we should use parseRes.data because PKCUserOptionsSchema sets a lot of defaults
    const parseRes = PKCUserOptionsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_PKC_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args
        });
    else
        return parseRes.data;
}
export function parseCreateRpcCommunityFunctionArgumentSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CreateRpcCommunityFunctionArgumentSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_COMMUNITY_WITH_RPC_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args
        });
    else
        return args;
}
export function parseCommentPubsubMessagePublicationWithPKCErrorIfItFails(args) {
    const parseRes = CommentPubsubMessageWithFlexibleAuthorRefinementSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_COMMENT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CommentPubsubMessagePublication"
        });
    else
        return args;
}
export function parseCreateCommentOptionsSchemaWithPKCErrorIfItFails(args) {
    const parseRes = CreateCommentOptionsWithRefinementSchema.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_CREATE_COMMENT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CreateCommentOptions"
        });
    else
        return args;
}
export function parseCommunityAddressWithPKCErrorIfItFails(args) {
    const parseRes = CreateCommentOptionsSchema.shape.communityAddress.safeParse(args);
    if (!parseRes.success)
        throw new PKCError("ERR_INVALID_COMMUNITY_ADDRESS_SCHEMA", {
            zodError: parseRes.error,
            args
        });
    else
        return args;
}
export function createSchemaRowParser(schema, options = {}) {
    const { prefix, coerceBooleans = true, parseJsonStrings = true, loose = true, validate = true } = options;
    const prefixLength = prefix?.length ?? 0;
    const parsedSchema = loose && typeof schema.loose === "function" ? schema.loose() : schema;
    const shape = schema.shape;
    const schemaKeys = new Set(Object.keys(shape));
    const booleanKeys = coerceBooleans ? collectBooleanKeys(shape) : new Set();
    const jsonKeys = parseJsonStrings ? collectJsonKeys(shape) : new Set();
    return (row) => {
        if (typeof row !== "object" || row === null) {
            throw new TypeError(`Expected row to be an object, received ${typeof row}`);
        }
        const record = row;
        const schemaInput = {};
        const extras = {};
        for (const [rawKey, rawValue] of Object.entries(record)) {
            if (prefix && !rawKey.startsWith(prefix))
                continue;
            const key = prefix ? rawKey.slice(prefixLength) : rawKey;
            const value = normalizeValue(rawValue, key, booleanKeys, jsonKeys, coerceBooleans, parseJsonStrings, prefix);
            if (schemaKeys.has(key))
                schemaInput[key] = value;
            else
                extras[key] = value;
        }
        if (validate) {
            const data = parsedSchema.parse(schemaInput);
            return { data, extras };
        }
        return { data: schemaInput, extras };
    };
}
function normalizeValue(value, key, booleanKeys, jsonKeys, coerceBooleans, parseJsonStrings, prefix) {
    if (value === null || value === undefined)
        return undefined;
    let current = value;
    if (coerceBooleans && booleanKeys.has(key))
        current = coerceBoolean(current);
    if (parseJsonStrings && jsonKeys.has(key))
        current = coerceJson(current, key, prefix);
    return current;
}
function coerceBoolean(value) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (value === 0)
            return false;
        if (value === 1)
            return true;
        return value;
    }
    if (typeof value === "bigint") {
        if (value === 0n)
            return false;
        if (value === 1n)
            return true;
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "0")
            return false;
        if (normalized === "1")
            return true;
        if (normalized === "true")
            return true;
        if (normalized === "false")
            return false;
    }
    return value;
}
function coerceJson(value, key, prefix) {
    if (typeof value !== "string")
        return value;
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return value;
    try {
        return JSON.parse(trimmed);
    }
    catch (error) {
        if (error && typeof error === "object") {
            error.details = {
                ...error.details,
                key: prefix ? `${prefix}${key}` : key,
                value: trimmed
            };
        }
        throw error;
    }
}
function collectBooleanKeys(shape) {
    const keys = new Set();
    for (const [key, childSchema] of Object.entries(shape))
        if (isBooleanLike(childSchema))
            keys.add(key);
    return keys;
}
function collectJsonKeys(shape) {
    const keys = new Set();
    for (const [key, childSchema] of Object.entries(shape))
        if (isJsonLike(childSchema))
            keys.add(key);
    return keys;
}
function isBooleanLike(schema) {
    const base = unwrapSchema(schema);
    const def = base?.def;
    if (!def)
        return false;
    const type = def.type;
    if (type === "boolean")
        return true;
    if (type === "literal")
        return typeof def.value === "boolean";
    if (type === "union")
        return def.options.every((option) => isBooleanLike(option));
    if (type === "intersection") {
        const { left, right } = def;
        return isBooleanLike(left) && isBooleanLike(right);
    }
    return false;
}
function isJsonLike(schema) {
    const base = unwrapSchema(schema);
    const def = base?.def;
    if (!def)
        return false;
    const type = def.type;
    if (jsonTypeNames.has(type))
        return true;
    if (type === "union") {
        const { options } = def;
        return options.every((option) => isJsonLike(option) || isNullish(option));
    }
    if (type === "intersection") {
        const { left, right } = def;
        return isJsonLike(left) || isJsonLike(right);
    }
    if (type === "lazy")
        return true;
    return false;
}
const jsonTypeNames = new Set(["object", "array", "tuple", "record", "map", "set"]);
function isNullish(schema) {
    const base = unwrapSchema(schema);
    const def = base?.def;
    if (!def)
        return false;
    if (def.type === "null")
        return true;
    if (def.type === "literal")
        return def.value === null;
    return false;
}
function unwrapSchema(schema, seen = new Set()) {
    if (seen.has(schema))
        return schema;
    seen.add(schema);
    const def = schema?.def;
    if (!def || !def.type)
        return schema;
    switch (def.type) {
        case "optional":
        case "nullable":
        case "default":
        case "catch":
        case "readonly":
            return unwrapSchema(def.innerType, seen);
        case "effects":
            return unwrapSchema(def.schema, seen);
        case "lazy":
            return unwrapSchema(def.getter(), seen);
        case "pipe":
            return unwrapSchema(def.out, seen);
        case "brand":
            return unwrapSchema(def.type, seen);
        default:
            return schema;
    }
}
//# sourceMappingURL=schema-util.js.map
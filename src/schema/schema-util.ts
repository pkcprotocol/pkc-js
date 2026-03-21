import { ModQueuePageIpfsSchema, PageIpfsSchema } from "../pages/schema.js";
import type { PageIpfs } from "../pages/types.js";
import { PlebbitError } from "../plebbit-error.js";
import {
    CommentChallengeRequestToEncryptSchema,
    CommentIpfsSchema,
    CommentPubsubMessagePublicationSchema,
    CommentPubsubMessageWithFlexibleAuthorRefinementSchema,
    CommentUpdateSchema,
    CreateCommentOptionsSchema,
    CreateCommentOptionsWithRefinementSchema
} from "../publications/comment/schema.js";
import type { CommentChallengeRequestToEncryptType, CommentIpfsType, CommentUpdateType } from "../publications/comment/types.js";
import {
    DecryptedChallengeAnswerSchema,
    DecryptedChallengeSchema,
    DecryptedChallengeVerificationSchema
} from "../pubsub-messages/schema.js";
import {
    CreateNewLocalSubplebbitUserOptionsSchema,
    CreateRemoteSubplebbitFunctionArgumentSchema,
    CreateRpcSubplebbitFunctionArgumentSchema,
    CreateSubplebbitFunctionArgumentsSchema,
    RpcRemoteSubplebbitUpdateEventResultSchema,
    SubplebbitEditOptionsSchema,
    SubplebbitIpfsSchema
} from "../subplebbit/schema.js";
import type {
    CreateNewLocalSubplebbitUserOptions,
    RpcRemoteSubplebbitUpdateEventResultType,
    SubplebbitEditOptions,
    SubplebbitIpfsType
} from "../subplebbit/types.js";
import type { DecryptedChallenge, DecryptedChallengeAnswer, DecryptedChallengeVerification } from "../pubsub-messages/types.js";
import { CidStringSchema } from "./schema.js";
import { RpcCommentEventResultSchema, RpcCommentUpdateResultSchema } from "../clients/rpc-client/schema.js";
import { CreatePlebbitWsServerOptionsSchema, SetNewSettingsPlebbitWsServerSchema } from "../rpc/src/schema.js";
import type { CreatePlebbitWsServerOptions, SetNewSettingsPlebbitWsServer } from "../rpc/src/types.js";
import type { CommentModerationChallengeRequestToEncrypt } from "../publications/comment-moderation/types.js";
import {
    CommentModerationChallengeRequestToEncryptSchema,
    CommentModerationPubsubMessagePublicationSchema,
    CreateCommentModerationOptionsSchema
} from "../publications/comment-moderation/schema.js";
import type { VoteChallengeRequestToEncryptType } from "../publications/vote/types.js";
import {
    CreateVoteUserOptionsSchema,
    VoteChallengeRequestToEncryptSchema,
    VotePubsubMessagePublicationSchema
} from "../publications/vote/schema.js";
import type { CommentEditChallengeRequestToEncryptType } from "../publications/comment-edit/types.js";
import {
    CommentEditChallengeRequestToEncryptSchema,
    CommentEditPubsubMessagePublicationSchema,
    CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema,
    CreateCommentEditOptionsSchema
} from "../publications/comment-edit/schema.js";
import { PlebbitUserOptionsSchema } from "../schema.js";
import { z, type ZodObject, type ZodType } from "zod";
import type {
    CreateSubplebbitEditPublicationOptions,
    SubplebbitEditChallengeRequestToEncryptType,
    SubplebbitEditPubsubMessagePublication
} from "../publications/subplebbit-edit/types.js";
import {
    CreateSubplebbitEditPublicationOptionsSchema,
    SubplebbitEditPublicationChallengeRequestToEncryptSchema,
    SubplebbitEditPubsubMessagePublicationSchema
} from "../publications/subplebbit-edit/schema.js";

export function parseJsonWithPlebbitErrorIfFails(x: string): any {
    try {
        return JSON.parse(x);
    } catch (e) {
        throw new PlebbitError("ERR_INVALID_JSON", { error: e, invalidJson: x });
    }
}

export function parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails(
    subIpfs: z.infer<typeof SubplebbitIpfsSchema>
): SubplebbitIpfsType {
    const parseRes = SubplebbitIpfsSchema.loose().safeParse(subIpfs);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_SUBPLEBBIT_IPFS_SCHEMA", {
            zodError: parseRes.error,
            subAddress: subIpfs?.address,
            subJson: subIpfs
        });
    else return subIpfs;
}

export function parseCommentIpfsSchemaWithPlebbitErrorIfItFails(commentIpfsJson: z.infer<typeof CommentIpfsSchema>): CommentIpfsType {
    const parseRes = CommentIpfsSchema.loose().safeParse(commentIpfsJson);
    if (!parseRes.success) throw new PlebbitError("ERR_INVALID_COMMENT_IPFS_SCHEMA", { zodError: parseRes.error, commentIpfsJson });
    else return <CommentIpfsType>commentIpfsJson;
}

export function parseCommentUpdateSchemaWithPlebbitErrorIfItFails(
    commentUpdateJson: z.infer<typeof CommentUpdateSchema>
): CommentUpdateType {
    const parseRes = CommentUpdateSchema.loose().safeParse(commentUpdateJson);
    if (!parseRes.success) throw new PlebbitError("ERR_INVALID_COMMENT_UPDATE_SCHEMA", { zodError: parseRes.error, commentUpdateJson });
    else return commentUpdateJson;
}

export function parsePageIpfsSchemaWithPlebbitErrorIfItFails(pageIpfsJson: z.infer<typeof PageIpfsSchema>): PageIpfs {
    const parseRes = PageIpfsSchema.safeParse(pageIpfsJson);
    if (!parseRes.success) throw new PlebbitError("ERR_INVALID_PAGE_IPFS_SCHEMA", { zodError: parseRes.error, pageIpfsJson });
    else return pageIpfsJson;
}

export function parseModQueuePageIpfsSchemaWithPlebbitErrorIfItFails(modQueuePageIpfsJson: z.infer<typeof ModQueuePageIpfsSchema>) {
    const parseRes = ModQueuePageIpfsSchema.safeParse(modQueuePageIpfsJson);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_MODQUEUE_PAGE_IPFS_SCHEMA", { zodError: parseRes.error, modQueuePageIpfsJson });
    else return modQueuePageIpfsJson;
}

export function parseDecryptedChallengeWithPlebbitErrorIfItFails(
    decryptedChallengeJson: z.infer<typeof DecryptedChallengeSchema>
): DecryptedChallenge {
    const parseRes = DecryptedChallengeSchema.loose().safeParse(decryptedChallengeJson);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CHALLENGE_DECRYPTED_SCHEMA", { zodError: parseRes.error, decryptedChallengeJson });
    else return decryptedChallengeJson;
}

export function parseDecryptedChallengeVerification(
    decryptedChallengeVerificationJson: z.infer<typeof DecryptedChallengeVerificationSchema>
): DecryptedChallengeVerification {
    const parseRes = DecryptedChallengeVerificationSchema.loose().safeParse(decryptedChallengeVerificationJson);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CHALLENGE_VERIFICATION_DECRYPTED_SCHEMA", {
            zodError: parseRes.error,
            decryptedChallengeVerificationJson
        });
    else return decryptedChallengeVerificationJson;
}

export function parseRpcRemoteSubplebbitUpdateEventWithPlebbitErrorIfItFails(
    rpcRemoteSubplebbit: RpcRemoteSubplebbitUpdateEventResultType
) {
    const parseRes = RpcRemoteSubplebbitUpdateEventResultSchema.strip().safeParse(rpcRemoteSubplebbit);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_RPC_REMOTE_SUBPLEBBIT_SCHEMA", {
            zodError: parseRes.error,
            rpcRemoteSubplebbit
        });
    else return rpcRemoteSubplebbit;
}

export function parseCidStringSchemaWithPlebbitErrorIfItFails(cidString: z.infer<typeof CidStringSchema>) {
    try {
        return CidStringSchema.parse(cidString);
    } catch (e) {
        throw new PlebbitError("ERR_INVALID_CID_STRING_SCHEMA", {
            zodError: e,
            cidString
        });
    }
}

export function parseRpcCommentUpdateEventWithPlebbitErrorIfItFails(
    updateResult: z.input<typeof RpcCommentUpdateResultSchema>
): z.infer<typeof RpcCommentUpdateResultSchema> {
    const parseRes = RpcCommentUpdateResultSchema.safeParse(updateResult);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_RPC_COMMENT_UPDATE_SCHEMA", {
            zodError: parseRes.error,
            updateResult
        });
    else return parseRes.data;
}

export function parseRpcCommentEventWithPlebbitErrorIfItFails(
    updateResult: z.input<typeof RpcCommentEventResultSchema>
): z.infer<typeof RpcCommentEventResultSchema> {
    const parseRes = RpcCommentEventResultSchema.safeParse(updateResult);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_RPC_COMMENT_SCHEMA", {
            zodError: parseRes.error,
            updateResult
        });
    else return parseRes.data;
}

export function parseSubplebbitEditPubsubMessagePublicationSchemaWithPlebbitErrorIfItFails(args: SubplebbitEditPubsubMessagePublication) {
    const parseRes = SubplebbitEditPubsubMessagePublicationSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_SUBPLEBBIT_EDIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "SubplebbitEditPubsubMessagePublication"
        });
    else return args;
}

export function parseCreateSubplebbitEditPublicationOptionsSchemaWithPlebbitErrorIfItFails(args: CreateSubplebbitEditPublicationOptions) {
    const parseRes = CreateSubplebbitEditPublicationOptionsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_SUBPLEBBIT_EDIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CreateSubplebbitEditPublicationOptions"
        });
    else return args;
}
export function parseDecryptedChallengeAnswerWithPlebbitErrorIfItFails(
    decryptedChallengeAnswers: z.infer<typeof DecryptedChallengeAnswerSchema>
): DecryptedChallengeAnswer {
    const parseRes = DecryptedChallengeAnswerSchema.safeParse(decryptedChallengeAnswers);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CHALLENGE_ANSWERS", {
            zodError: parseRes.error,
            challengeAnswers: decryptedChallengeAnswers
        });
    else return decryptedChallengeAnswers;
}

export function parseCreatePlebbitWsServerOptionsSchemaWithPlebbitErrorIfItFails(
    options: z.infer<typeof CreatePlebbitWsServerOptionsSchema>
): CreatePlebbitWsServerOptions {
    const parseRes = CreatePlebbitWsServerOptionsSchema.safeParse(options);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_PLEBBIT_WS_SERVER_OPTIONS_SCHEMA", {
            zodError: parseRes.error,
            challengeAnswers: options
        });
    else return options;
}

export function parseCommentModerationChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails(
    toEncrypt: z.infer<typeof CommentModerationChallengeRequestToEncryptSchema>
): CommentModerationChallengeRequestToEncrypt {
    const parseRes = CommentModerationChallengeRequestToEncryptSchema.safeParse(toEncrypt);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_COMMENT_MODERATION_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA", {
            zodError: parseRes.error,
            toEncrypt
        });
    else return toEncrypt;
}

export function parseSubplebbitEditChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails(
    toEncrypt: z.infer<typeof SubplebbitEditPublicationChallengeRequestToEncryptSchema>
): SubplebbitEditChallengeRequestToEncryptType {
    const parseRes = SubplebbitEditPublicationChallengeRequestToEncryptSchema.safeParse(toEncrypt);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_SUBPLEBBIT_EDIT_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA", {
            zodError: parseRes.error,
            toEncrypt
        });
    else return toEncrypt;
}

export function parseSubplebbitEditOptionsSchemaWithPlebbitErrorIfItFails(
    editOptions: z.infer<typeof SubplebbitEditOptionsSchema>
): SubplebbitEditOptions {
    const parseRes = SubplebbitEditOptionsSchema.safeParse(editOptions);
    if (!parseRes.success)
        throw new PlebbitError("ERR_SUBPLEBBIT_EDIT_OPTIONS_SCHEMA", {
            zodError: parseRes.error,
            editOptions
        });
    else return editOptions;
}

export function parseCommentChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails(
    toEncrypt: z.infer<typeof CommentChallengeRequestToEncryptSchema>
): CommentChallengeRequestToEncryptType {
    const parseRes = CommentChallengeRequestToEncryptSchema.loose().safeParse(toEncrypt);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_COMMENT_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA", {
            zodError: parseRes.error,
            toEncrypt
        });
    else return toEncrypt;
}

export function parseVoteChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails(
    toEncrypt: z.infer<typeof VoteChallengeRequestToEncryptSchema>
): VoteChallengeRequestToEncryptType {
    const parseRes = VoteChallengeRequestToEncryptSchema.safeParse(toEncrypt);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_VOTE_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA", {
            zodError: parseRes.error,
            toEncrypt
        });
    else return toEncrypt;
}

export function parseCommentEditChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails(
    toEncrypt: z.infer<typeof CommentEditChallengeRequestToEncryptSchema>
): CommentEditChallengeRequestToEncryptType {
    const parseRes = CommentEditChallengeRequestToEncryptSchema.safeParse(toEncrypt);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_COMMENT_EDIT_CHALLENGE_REQUEST_TO_ENCRYPT_SCHEMA", {
            zodError: parseRes.error,
            toEncrypt
        });
    else return toEncrypt;
}

export function parseCreateNewLocalSubplebbitUserOptionsSchemaWithPlebbitErrorIfItFails(
    options: z.infer<typeof CreateNewLocalSubplebbitUserOptionsSchema>
): CreateNewLocalSubplebbitUserOptions {
    const parseRes = CreateNewLocalSubplebbitUserOptionsSchema.safeParse(options);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_NEW_LOCAL_SUB_USER_OPTIONS", {
            zodError: parseRes.error,
            options
        });
    else return options;
}

export function parseSetNewSettingsPlebbitWsServerSchemaWithPlebbitErrorIfItFails(
    settings: z.input<typeof SetNewSettingsPlebbitWsServerSchema>
): z.input<typeof SetNewSettingsPlebbitWsServerSchema> {
    const parseRes = SetNewSettingsPlebbitWsServerSchema.safeParse(settings);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_NEW_WS_SERVER_SETTINGS_SCHEMA", {
            zodError: parseRes.error,
            settings
        });
    else return settings;
}

export function parseCreateCommentModerationOptionsSchemaWithPlebbitErrorIfItFails(
    args: z.infer<typeof CreateCommentModerationOptionsSchema>
) {
    const parseRes = CreateCommentModerationOptionsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_COMMENT_MODERATION_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CreateCommentModerationOptions"
        });
    else return args;
}

export function parseCommentModerationPubsubMessagePublicationSchemaWithPlebbitErrorIfItFails(
    args: z.infer<typeof CommentModerationPubsubMessagePublicationSchema>
) {
    const parseRes = CommentModerationPubsubMessagePublicationSchema.loose().safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_COMMENT_MODERATION_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CommentModerationPubsubMessagePublication"
        });
    else return args;
}

export function parseCreateRemoteSubplebbitFunctionArgumentSchemaWithPlebbitErrorIfItFails(
    args: any
): z.infer<typeof CreateRemoteSubplebbitFunctionArgumentSchema> {
    const parseRes = CreateRemoteSubplebbitFunctionArgumentSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_REMOTE_SUBPLEBBIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args
        });
    else return args;
}

export function parseCreateVoteOptionsSchemaWithPlebbitErrorIfItFails(args: z.infer<typeof CreateVoteUserOptionsSchema>) {
    const parseRes = CreateVoteUserOptionsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_VOTE_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CreateVoteOptions"
        });
    else return args;
}

export function parseVotePubsubMessagePublicationSchemaWithPlebbitErrorIfItFails(args: z.infer<typeof VotePubsubMessagePublicationSchema>) {
    const parseRes = VotePubsubMessagePublicationSchema.loose().safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_VOTE_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "VotePubsubMessagePublication"
        });
    else return args;
}

export function parseCreateCommentEditOptionsSchemaWithPlebbitErrorIfItFails(args: z.infer<typeof CreateCommentEditOptionsSchema>) {
    const parseRes = CreateCommentEditOptionsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_COMMENT_EDIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CreateCommentEditOptions"
        });
    else return args;
}

export function parseCommentEditPubsubMessagePublicationSchemaWithPlebbitErrorIfItFails(
    args: z.infer<typeof CommentEditPubsubMessagePublicationSchema>
) {
    const parseRes = CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_COMMENT_EDIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CommentEditPubsubMessagePublication"
        });
    else return args;
}

export function parseCreateSubplebbitFunctionArgumentsSchemaWithPlebbitErrorIfItFails(
    args: z.infer<typeof CreateSubplebbitFunctionArgumentsSchema>
) {
    const parseRes = CreateSubplebbitFunctionArgumentsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_SUBPLEBBIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args
        });
    else return args;
}

export function parsePlebbitUserOptionsSchemaWithPlebbitErrorIfItFails(args: any): z.infer<typeof PlebbitUserOptionsSchema> {
    // normally we don't change args, but here we should use parseRes.data because PlebbitUserOptionsSchema sets a lot of defaults
    const parseRes = PlebbitUserOptionsSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_PLEBBIT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args
        });
    else return parseRes.data;
}

export function parseCreateRpcSubplebbitFunctionArgumentSchemaWithPlebbitErrorIfItFails(
    args: z.infer<typeof CreateRpcSubplebbitFunctionArgumentSchema>
) {
    const parseRes = CreateRpcSubplebbitFunctionArgumentSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_SUBPLEBBIT_WITH_RPC_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args
        });
    else return args;
}

export function parseCommentPubsubMessagePublicationWithPlebbitErrorIfItFails(args: z.infer<typeof CommentPubsubMessagePublicationSchema>) {
    const parseRes = CommentPubsubMessageWithFlexibleAuthorRefinementSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_COMMENT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CommentPubsubMessagePublication"
        });
    else return args;
}

export function parseCreateCommentOptionsSchemaWithPlebbitErrorIfItFails(args: z.infer<typeof CreateCommentOptionsSchema>) {
    const parseRes = CreateCommentOptionsWithRefinementSchema.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_CREATE_COMMENT_ARGS_SCHEMA", {
            zodError: parseRes.error,
            args,
            type: "CreateCommentOptions"
        });
    else return args;
}

export function parseSubplebbitAddressWithPlebbitErrorIfItFails(args: z.infer<typeof CreateCommentOptionsSchema.shape.subplebbitAddress>) {
    const parseRes = CreateCommentOptionsSchema.shape.subplebbitAddress.safeParse(args);
    if (!parseRes.success)
        throw new PlebbitError("ERR_INVALID_SUBPLEBBIT_ADDRESS_SCHEMA", {
            zodError: parseRes.error,
            args
        });
    else return args;
}

export type SchemaRowParserOptions = {
    prefix?: string;
    coerceBooleans?: boolean;
    parseJsonStrings?: boolean;
    loose?: boolean;
    validate?: boolean;
};

type ObjectSchema = ZodObject<any, any>;
type SchemaShape = Record<string, ZodType>;

export interface SchemaRowParserResult<Schema extends ObjectSchema> {
    data: z.output<Schema>;
    extras: Record<string, unknown>;
}

export function createSchemaRowParser<Schema extends ObjectSchema>(
    schema: Schema,
    options: SchemaRowParserOptions = {}
): (row: unknown) => SchemaRowParserResult<Schema> {
    const { prefix, coerceBooleans = true, parseJsonStrings = true, loose = true, validate = true } = options;
    const prefixLength = prefix?.length ?? 0;
    const parsedSchema = loose && typeof (schema as any).loose === "function" ? (schema as any).loose() : schema;
    const shape = schema.shape as SchemaShape;
    const schemaKeys = new Set(Object.keys(shape));
    const booleanKeys = coerceBooleans ? collectBooleanKeys(shape) : new Set<string>();
    const jsonKeys = parseJsonStrings ? collectJsonKeys(shape) : new Set<string>();

    return (row) => {
        if (typeof row !== "object" || row === null) {
            throw new TypeError(`Expected row to be an object, received ${typeof row}`);
        }

        const record = row as Record<string, unknown>;
        const schemaInput: Record<string, any> = {};
        const extras: Record<string, any> = {};

        for (const [rawKey, rawValue] of Object.entries(record)) {
            if (prefix && !rawKey.startsWith(prefix)) continue;
            const key = prefix ? rawKey.slice(prefixLength) : rawKey;
            const value = normalizeValue(rawValue, key, booleanKeys, jsonKeys, coerceBooleans, parseJsonStrings, prefix);
            if (schemaKeys.has(key)) schemaInput[key] = value;
            else extras[key] = value;
        }

        if (validate) {
            const data = parsedSchema.parse(schemaInput) as z.output<Schema>;
            return { data, extras };
        }

        return { data: schemaInput as z.output<Schema>, extras };
    };
}

function normalizeValue(
    value: unknown,
    key: string,
    booleanKeys: Set<string>,
    jsonKeys: Set<string>,
    coerceBooleans: boolean,
    parseJsonStrings: boolean,
    prefix?: string
): any {
    if (value === null || value === undefined) return undefined;
    let current: any = value;

    if (coerceBooleans && booleanKeys.has(key)) current = coerceBoolean(current);
    if (parseJsonStrings && jsonKeys.has(key)) current = coerceJson(current, key, prefix);

    return current;
}

function coerceBoolean(value: unknown): any {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (value === 0) return false;
        if (value === 1) return true;
        return value;
    }
    if (typeof value === "bigint") {
        if (value === 0n) return false;
        if (value === 1n) return true;
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "0") return false;
        if (normalized === "1") return true;
        if (normalized === "true") return true;
        if (normalized === "false") return false;
    }
    return value;
}

function coerceJson(value: unknown, key: string, prefix?: string): any {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed.length === 0) return value;
    try {
        return JSON.parse(trimmed);
    } catch (error) {
        if (error && typeof error === "object") {
            (error as any).details = {
                ...(error as any).details,
                key: prefix ? `${prefix}${key}` : key,
                value: trimmed
            };
        }
        throw error;
    }
}

function collectBooleanKeys(shape: SchemaShape): Set<string> {
    const keys = new Set<string>();
    for (const [key, childSchema] of Object.entries(shape)) if (isBooleanLike(childSchema)) keys.add(key);
    return keys;
}

function collectJsonKeys(shape: SchemaShape): Set<string> {
    const keys = new Set<string>();
    for (const [key, childSchema] of Object.entries(shape)) if (isJsonLike(childSchema)) keys.add(key);
    return keys;
}

function isBooleanLike(schema: ZodType): boolean {
    const base = unwrapSchema(schema);
    const def: any = base?.def;
    if (!def) return false;
    const type = def.type;
    if (type === "boolean") return true;
    if (type === "literal") return typeof def.value === "boolean";
    if (type === "union") return (def.options as ZodType[]).every((option) => isBooleanLike(option));
    if (type === "intersection") {
        const { left, right } = def;
        return isBooleanLike(left) && isBooleanLike(right);
    }
    return false;
}

function isJsonLike(schema: ZodType): boolean {
    const base = unwrapSchema(schema);
    const def: any = base?.def;
    if (!def) return false;
    const type = def.type;
    if (jsonTypeNames.has(type)) return true;
    if (type === "union") {
        const { options } = def as { options: ZodType[] };
        return options.every((option: ZodType) => isJsonLike(option) || isNullish(option));
    }
    if (type === "intersection") {
        const { left, right } = def;
        return isJsonLike(left) || isJsonLike(right);
    }
    if (type === "lazy") return true;
    return false;
}

const jsonTypeNames = new Set(["object", "array", "tuple", "record", "map", "set"]);

function isNullish(schema: ZodType): boolean {
    const base = unwrapSchema(schema);
    const def: any = base?.def;
    if (!def) return false;
    if (def.type === "null") return true;
    if (def.type === "literal") return def.value === null;
    return false;
}

function unwrapSchema(schema: ZodType, seen = new Set<ZodType>()): ZodType {
    if (seen.has(schema)) return schema;
    seen.add(schema);
    const def: any = schema?.def;
    if (!def || !def.type) return schema;
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

import { z } from "zod";
import {
    AuthorAddressSchema,
    ChallengeAnswerStringSchema,
    CidStringSchema,
    CreateSignerSchema,
    FlairSchema,
    JsonSignatureSchema,
    PlebbitTimestampSchema,
    ProtocolVersionSchema,
    SignerWithAddressPublicKeySchema,
    SubplebbitAddressSchema
} from "../schema/schema.js";
import { ModQueuePagesIpfsSchema, PostsPagesIpfsSchema } from "../pages/schema.js";
import { LocalSubplebbit } from "../runtime/node/subplebbit/local-subplebbit.js";
import * as remeda from "remeda";
import type { DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor } from "../pubsub-messages/types.js";
import { messages } from "../errors.js";
import { nonNegativeIntStringSchema } from "../schema.js";

// Other props of Subplebbit Ipfs here
export const SubplebbitEncryptionSchema = z.looseObject({
    type: z.string().min(1), // https://github.com/plebbit/plebbit-js/blob/master/docs/encryption.md
    publicKey: SignerWithAddressPublicKeySchema.shape.publicKey // 32 bytes base64 string (same as subplebbit.signer.publicKey)
});

export const SubplebbitRoleNames = z.enum(["owner", "admin", "moderator"]);
export const SubplebbitRoleSchema = z.looseObject({
    role: SubplebbitRoleNames.or(z.string().min(1))
});

export const PubsubTopicSchema = z.string().min(1);

export const SubplebbitSuggestedSchema = z.looseObject({
    // values suggested by the sub owner, the client/user can ignore them without breaking interoperability
    primaryColor: z.string().optional(),
    secondaryColor: z.string().optional(),
    avatarUrl: z.string().min(1).optional(),
    bannerUrl: z.string().min(1).optional(),
    backgroundUrl: z.string().min(1).optional(),
    language: z.string().optional()
    // TODO: menu links, wiki pages, sidebar widgets
});

export const SubplebbitFeaturesSchema = z.looseObject({
    // any boolean that changes the functionality of the sub, add "no" in front if doesn't default to false
    noVideos: z.boolean().optional(), // Block all comments with video links
    noSpoilers: z.boolean().optional(), // Author can't set spoiler = true on any comment
    noImages: z.boolean().optional(), // Block all comments with image links
    noVideoReplies: z.boolean().optional(), // Block only replies with video links
    noSpoilerReplies: z.boolean().optional(), // Author can't set spoiler = true on replies
    noImageReplies: z.boolean().optional(), // Block only replies with image links
    noPolls: z.boolean().optional(), // Not impllemented
    noCrossposts: z.boolean().optional(), // Not implemented
    noNestedReplies: z.boolean().optional(), // No nested replies, like old school forums and 4chan. Maximum depth is 1
    safeForWork: z.boolean().optional(), // Informational flag indicating this subplebbit is safe for work
    authorFlairs: z.boolean().optional(), // Authors can choose their own author flairs (otherwise only mods can)
    requireAuthorFlairs: z.boolean().optional(), // Force authors to choose an author flair before posting
    postFlairs: z.boolean().optional(), // Authors can choose their own post flairs (otherwise only mods can)
    requirePostFlairs: z.boolean().optional(), // Force authors to choose a post flair before posting
    noMarkdownImages: z.boolean().optional(), // Don't allow embedding images in markdown content (![alt](url) or <img> tags)
    noMarkdownVideos: z.boolean().optional(), // Don't allow embedding videos in markdown content (![alt](video-url), <video> or <iframe> tags)
    noMarkdownAudio: z.boolean().optional(), // Don't allow embedding audio in markdown content (![alt](audio-url) or <audio> tags)
    noAudio: z.boolean().optional(), // Block all comments with audio links
    noAudioReplies: z.boolean().optional(), // Block only replies with audio links
    markdownImageReplies: z.boolean().optional(), // Not implemented
    markdownVideoReplies: z.boolean().optional(), // Not implemented
    noPostUpvotes: z.boolean().optional(), // Not allowed to publish a vote=1 to comment with depth = 0
    noReplyUpvotes: z.boolean().optional(), // not allowed to publish a vote=1 to comment with depth > 0
    noPostDownvotes: z.boolean().optional(), // not allowed to publish a vote=-1 to comment with depth = 0
    noReplyDownvotes: z.boolean().optional(), // not allowed to publish a vote=-1 to comment with depth > 0
    noUpvotes: z.boolean().optional(), // Not allowed to publish a vote=1
    noDownvotes: z.boolean().optional(), // Not allowed to publish a vote=-1
    requirePostLink: z.boolean().optional(), // post.link must be defined and a valid https url
    requirePostLinkIsMedia: z.boolean().optional(), // post.link must be of media (audio, video, image)
    requireReplyLink: z.boolean().optional(), // reply.link must be defined and a valid https url
    requireReplyLinkIsMedia: z.boolean().optional(), // reply.link must be of media (audio, video, image)
    pseudonymityMode: z.enum(["per-post", "per-reply", "per-author"]).optional() // Controls author address anonymization: per-post (new address each post), per-reply (new address each reply), per-author (consistent address)
});

// Local subplebbit challenge here (Challenges API)

export const ChallengeOptionInputSchema = z.looseObject({
    option: z.string(), // option property name, e.g. characterCount
    label: z.string(), // option title, e.g. Character Count
    default: z.string().optional(), // option default value, e.g. "10"
    description: z.string().optional(), // e.g. Amount of characters of the captcha
    placeholder: z.string().optional(), // the value to display if the input field is empty, e.g. "10"
    required: z.boolean().optional() // If this is true, the challenge option is required, the challenge will throw without it
}); // should be flexible

export const ChallengeResultSchema = z.object({ success: z.literal(true) }).or(z.object({ success: z.literal(false), error: z.string() }));

export const ChallengeFromGetChallengeSchema = z
    .object({
        challenge: z.string(), // e.g. '2 + 2'
        verify: z.function({ input: [z.lazy(() => ChallengeAnswerStringSchema)], output: z.promise(ChallengeResultSchema) }),
        type: z.string().min(1),
        caseInsensitive: z.boolean().optional()
    })
    .strict();

export const ResultOfGetChallengeSchema = ChallengeFromGetChallengeSchema.or(ChallengeResultSchema);

export const ChallengeExcludeSubplebbitSchema = z
    .object({
        addresses: SubplebbitAddressSchema.array().nonempty(), // list of subplebbit addresses that can be used to exclude, plural because not a condition field like 'role'
        maxCommentCids: z.number().nonnegative().int(), // maximum amount of comment cids that will be fetched to check
        postScore: z.number().int().optional(),
        replyScore: z.number().int().optional(),
        firstCommentTimestamp: PlebbitTimestampSchema.optional() // exclude if author account age is greater or equal than now - firstCommentTimestamp
    })
    .strict();

const excludePublicationFieldSchema = z.boolean().optional(); // can be true or undefined

export const ChallengeExcludePublicationTypeSchema = z
    .looseObject({
        post: excludePublicationFieldSchema,
        reply: excludePublicationFieldSchema,
        vote: excludePublicationFieldSchema,
        commentEdit: excludePublicationFieldSchema,
        commentModeration: excludePublicationFieldSchema,
        subplebbitEdit: excludePublicationFieldSchema
    })
    .refine(
        (args) => !remeda.isEmpty(JSON.parse(JSON.stringify(args))), // is it empty object {} or {field: undefined}? throw if so
        messages.ERR_CAN_NOT_SET_EXCLUDE_PUBLICATION_TO_EMPTY_OBJECT
    );

export const ChallengeExcludeSchema = z.looseObject({
    subplebbit: ChallengeExcludeSubplebbitSchema.optional(),
    postScore: z.number().int().optional(),
    replyScore: z.number().int().optional(),
    postCount: z.number().nonnegative().int().optional(),
    replyCount: z.number().nonnegative().int().optional(),
    firstCommentTimestamp: PlebbitTimestampSchema.optional(),
    challenges: z.number().nonnegative().int().array().optional(),
    role: SubplebbitRoleSchema.shape.role.array().optional(),
    address: AuthorAddressSchema.array().optional(),
    rateLimit: z.number().nonnegative().int().optional(),
    rateLimitChallengeSuccess: z.boolean().optional(),
    publicationType: ChallengeExcludePublicationTypeSchema.optional()
});

export const SubplebbitChallengeSettingSchema = z
    .object({
        // the private settings of the challenge (subplebbit.settings.challenges)
        path: z.string().optional(), // (only if name is undefined) the path to the challenge js file, used to get the props ChallengeFile {optionInputs, type, getChallenge}
        name: z.string().optional(), // (only if path is undefined) the challengeName from Plebbit.challenges to identify it
        options: z.record(z.string(), z.string()).optional(), //{ [optionPropertyName: string]: string } the options to be used to the getChallenge function, all values must be strings for UI ease of use
        exclude: ChallengeExcludeSchema.array().nonempty().optional(), // singular because it only has to match 1 exclude, the client must know the exclude setting to configure what challengeCommentCids to send
        description: z.string().optional(), // describe in the frontend what kind of challenge the user will receive when publishing
        pendingApproval: z.boolean().optional()
    })
    .strict()
    .refine((challengeData) => challengeData.path || challengeData.name, "Path or name of challenge has to be defined");

export const GetChallengeArgsSchema = z.object({
    challengeSettings: SubplebbitChallengeSettingSchema,
    challengeRequestMessage: z.custom<DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor>(), // no need to validate because extra props may be there
    challengeIndex: z.number().int().nonnegative(),
    subplebbit: z.custom<LocalSubplebbit>()
});

export const ChallengeFileSchema = z
    .object({
        // the result of the function exported by the challenge file
        optionInputs: ChallengeOptionInputSchema.array().optional(), // the options inputs fields to display to the user
        type: ChallengeFromGetChallengeSchema.shape.type,
        challenge: ChallengeFromGetChallengeSchema.shape.challenge.optional(), // some challenges can be static and asked before the user publishes, like a password for example
        caseInsensitive: z.boolean().optional(), // challenge answer capitalization is ignored, informational only option added by the challenge file
        description: z.string().optional(), // describe what the challenge does to display in the UI
        getChallenge: z.function({
            input: [GetChallengeArgsSchema],
            output: z.promise(ResultOfGetChallengeSchema)
        })
    })
    .strict();

export const SubplebbitChallengeSchema = z.looseObject({
    exclude: ChallengeExcludeSchema.array().nonempty().optional(),
    description: ChallengeFileSchema.shape.description,
    challenge: ChallengeFileSchema.shape.challenge,
    type: ChallengeFileSchema.shape.type,
    caseInsensitive: ChallengeFileSchema.shape.caseInsensitive,
    pendingApproval: z.boolean().optional()
});
export const ChallengeFileFactoryArgsSchema = z.object({
    challengeSettings: SubplebbitChallengeSettingSchema
});

export const ChallengeFileFactorySchema = z.function({ input: [ChallengeFileFactoryArgsSchema], output: ChallengeFileSchema });

// Subplebbit actual schemas here

export const SubplebbitIpfsSchema = z
    .object({
        posts: PostsPagesIpfsSchema.optional(),
        modQueue: ModQueuePagesIpfsSchema.optional(),
        challenges: SubplebbitChallengeSchema.array(),
        signature: JsonSignatureSchema,
        encryption: SubplebbitEncryptionSchema,
        address: SubplebbitAddressSchema,
        createdAt: PlebbitTimestampSchema,
        updatedAt: PlebbitTimestampSchema,
        pubsubTopic: PubsubTopicSchema.optional(),
        statsCid: CidStringSchema,
        protocolVersion: ProtocolVersionSchema,
        postUpdates: z.record(nonNegativeIntStringSchema, CidStringSchema).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        roles: z.record(AuthorAddressSchema, SubplebbitRoleSchema).optional(),
        rules: z.string().array().optional(),
        lastPostCid: CidStringSchema.optional(),
        lastCommentCid: CidStringSchema.optional(),
        features: SubplebbitFeaturesSchema.optional(),
        suggested: SubplebbitSuggestedSchema.optional(),
        flairs: z.record(z.string(), FlairSchema.array()).optional()
    })
    .strict();

export const SubplebbitSignedPropertyNames = remeda.keys.strict(remeda.omit(SubplebbitIpfsSchema.shape, ["signature"]));

// This is object transmitted by RPC server to RPC client when it's fetching a remote subplebbit
export const RpcRemoteSubplebbitUpdateEventResultSchema = z.object({
    subplebbit: SubplebbitIpfsSchema.loose(),
    runtimeFields: z
        .object({
            updateCid: CidStringSchema,
            updatingState: z.custom<LocalSubplebbit["updatingState"]>().optional()
        })
        .passthrough()
});
// If you're trying to create a subplebbit instance with any props, all props are optional except address

export const CreateRemoteSubplebbitOptionsSchema = SubplebbitIpfsSchema.partial()
    .merge(SubplebbitIpfsSchema.pick({ address: true }))
    .extend({
        posts: SubplebbitIpfsSchema.shape.posts.or(PostsPagesIpfsSchema.pick({ pageCids: true })),
        updateCid: CidStringSchema.optional()
    })
    .strict();

// Local Subplebbit schemas

export const SubplebbitSettingsSchema = z
    .object({
        fetchThumbnailUrls: z.boolean().optional(),
        fetchThumbnailUrlsProxyUrl: z.string().optional(), // TODO should we validate this url?
        challenges: SubplebbitChallengeSettingSchema.array().optional(), // If empty array it will remove all challenges
        maxPendingApprovalCount: z.number().int().nonnegative().optional(),
        purgeDisapprovedCommentsOlderThan: z.number().int().nonnegative().optional()
    })
    .strict();

const SubplebbitRoleToEditSchema = SubplebbitRoleSchema.or(z.undefined()); // when we pass undefined we're removing the role

const SubplebbitRolesToEditSchema = z.record(AuthorAddressSchema, SubplebbitRoleToEditSchema);

export const SubplebbitEditOptionsSchema = SubplebbitIpfsSchema.pick({
    flairs: true,
    address: true,
    title: true,
    description: true,
    roles: true,
    rules: true,
    pubsubTopic: true,
    features: true,
    suggested: true
})
    .extend({
        settings: SubplebbitSettingsSchema.optional(),
        roles: SubplebbitRolesToEditSchema.optional()
    })
    .partial()
    .strict();

// These are the options to create a new local sub, provided by user

export const CreateNewLocalSubplebbitUserOptionsSchema = SubplebbitEditOptionsSchema.omit({ address: true })
    .extend({
        signer: CreateSignerSchema.optional(),
        roles: SubplebbitIpfsSchema.shape.roles
    })
    .strict();

// These are the options that go straight into _createLocalSub, create a new brand local sub. This is after parsing of plebbit-js
export const CreateNewLocalSubplebbitParsedOptionsSchema = CreateNewLocalSubplebbitUserOptionsSchema.extend({
    address: SignerWithAddressPublicKeySchema.shape.address,
    signer: SignerWithAddressPublicKeySchema
}).strict();

// | CreateNewLocalSubplebbitUserOptions
// | CreateRemoteSubplebbitOptions
// | RemoteSubplebbitJsonType
// | SubplebbitIpfsType
// | InternalSubplebbitType
// | RemoteSubplebbit
// | RpcLocalSubplebbit
// | RpcRemoteSubplebbit
// | LocalSubplebbit = {}

export const CreateRemoteSubplebbitFunctionArgumentSchema = CreateRemoteSubplebbitOptionsSchema.or(SubplebbitIpfsSchema.loose());

export const CreateRpcSubplebbitFunctionArgumentSchema = CreateRemoteSubplebbitFunctionArgumentSchema.or(
    CreateNewLocalSubplebbitUserOptionsSchema
);

export const CreateSubplebbitFunctionArgumentsSchema = CreateNewLocalSubplebbitUserOptionsSchema.or(
    CreateRemoteSubplebbitFunctionArgumentSchema
);

// plebbit.listSubplebbits()

export const ListOfSubplebbitsSchema = SubplebbitAddressSchema.array();

// Reserved fields

// TODO should make the array of class props typed
export const SubplebbitIpfsReservedFields = remeda.difference(
    [
        "cid",
        "shortCid",
        "updateCid",
        "shortUpdateCid",
        "shortAddress",
        "raw",
        "shortSubplebbitAddress",
        "deleted",
        "signer",
        "state",
        "clients",
        "startedState",
        "settings",
        "editable",
        "publishingState",
        "updatingState",
        "started"
    ],
    remeda.keys.strict(SubplebbitIpfsSchema.shape)
);

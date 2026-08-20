import { z } from "zod";
import {
    AuthorAddressSchema,
    ChallengeAnswerStringSchema,
    CidStringSchema,
    CreateSignerSchema,
    FlairSchema,
    JsonSignatureSchema,
    PKCTimestampSchema,
    ProtocolVersionSchema,
    SignerWithAddressPublicKeySchema,
    CommunityAddressSchema,
    isIpnsName,
    nonNegativeIntStringSchema
} from "../schema/schema.js";
import { ModQueuePagesIpfsSchema, PostsPagesIpfsSchema } from "../pages/schema.js";
import type { LocalCommunity } from "../runtime/node/community/local-community.js";
import { difference, isEmpty, keys, omit } from "remeda";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../pubsub-messages/types.js";
import { messages } from "../errors.js";

// Other props of Community Ipfs here
export const CommunityEncryptionSchema = z.looseObject({
    type: z.string().min(1), // https://github.com/plebbit/plebbit-js/blob/master/docs/encryption.md
    publicKey: SignerWithAddressPublicKeySchema.shape.publicKey // 32 bytes base64 string (same as community.signer.publicKey)
});

export const CommunityRoleNames = z.enum(["owner", "admin", "moderator"]);
export const CommunityRoleSchema = z.looseObject({
    role: CommunityRoleNames.or(z.string().min(1))
});

export const PubsubTopicSchema = z.string().min(1);

export const CommunitySuggestedSchema = z.looseObject({
    // values suggested by the community owner, the client/user can ignore them without breaking interoperability
    primaryColor: z.string().optional(),
    secondaryColor: z.string().optional(),
    avatarUrl: z.string().min(1).optional(),
    bannerUrl: z.string().min(1).optional(),
    backgroundUrl: z.string().min(1).optional(),
    language: z.string().optional()
    // TODO: menu links, wiki pages, sidebar widgets
});

export const CommunityFeaturesSchema = z.looseObject({
    // any boolean that changes the functionality of the community, add "no" in front if doesn't default to false
    noVideos: z.boolean().optional(), // Block all comments with video links
    noSpoilers: z.boolean().optional(), // Author can't set spoiler = true on any comment
    noImages: z.boolean().optional(), // Block all comments with image links
    noVideoReplies: z.boolean().optional(), // Block only replies with video links
    noSpoilerReplies: z.boolean().optional(), // Author can't set spoiler = true on replies
    noImageReplies: z.boolean().optional(), // Block only replies with image links
    noReplyLinks: z.boolean().optional(), // Block all replies that have a link field set
    noPolls: z.boolean().optional(), // Not impllemented
    noCrossposts: z.boolean().optional(), // Reject comments carrying a crosspost. Inbound only: it does not stop this community's comments being crossposted elsewhere
    // Longest crosspost chain this community accepts, counted as the number of embedded records (a plain crosspost is 1).
    // Absent means the protocol cap MAX_CROSSPOST_DEPTH. A value above it is clamped down to it, never up: clients enforce
    // the hard cap on every ingest path, so a community accepting deeper chains would publish comments nobody can load.
    // Deliberately not bounded by the schema, so a value from a future protocol version doesn't fail the whole record.
    maxCrosspostDepth: z.number().int().nonnegative().optional(),
    noNestedReplies: z.boolean().optional(), // No nested replies, like old school forums and 4chan. Maximum depth is 1
    safeForWork: z.boolean().optional(), // Informational flag indicating this community is safe for work
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

// Local community challenge here (Challenges API)

export const ChallengeOptionInputSchema = z.looseObject({
    option: z.string(), // option property name, e.g. characterCount
    label: z.string(), // option title, e.g. Character Count
    default: z.string().optional(), // option default value, e.g. "10"
    description: z.string().optional(), // e.g. Amount of characters of the captcha
    placeholder: z.string().optional(), // the value to display if the input field is empty, e.g. "10"
    required: z.boolean().optional() // If this is true, the challenge option is required, the challenge will throw without it
}); // should be flexible

// `comment` and `commentUpdate` are typed as loose records here — allowed-key validation happens in
// validateChallengeResultExtras during aggregation, so we can emit a precise PKCError with
// {challengeIndex, offendingKey} instead of a generic Zod failure.
export const ChallengeResultSchema = z
    .object({
        success: z.literal(true),
        comment: z.looseObject({}).optional(),
        commentUpdate: z.looseObject({}).optional()
    })
    .or(
        z.object({
            success: z.literal(false),
            error: z.string(),
            reason: z.string().optional()
        })
    );

export const ChallengeFromGetChallengeSchema = z
    .object({
        challenge: z.string(), // e.g. '2 + 2'
        verify: z.function({ input: [z.lazy(() => ChallengeAnswerStringSchema)], output: z.promise(ChallengeResultSchema) }),
        type: z.string().min(1),
        caseInsensitive: z.boolean().optional()
    })
    .strict();

export const ResultOfGetChallengeSchema = ChallengeFromGetChallengeSchema.or(ChallengeResultSchema);

export const ChallengeExcludeCommunitySchema = z
    .object({
        addresses: CommunityAddressSchema.array().nonempty(), // list of community addresses that can be used to exclude, plural because not a condition field like 'role'
        maxCommentCids: z.number().nonnegative().int(), // maximum amount of comment cids that will be fetched to check
        postScore: z.number().int().optional(),
        replyScore: z.number().int().optional(),
        firstCommentTimestamp: PKCTimestampSchema.optional() // exclude if author account age is greater or equal than now - firstCommentTimestamp
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
        communityEdit: excludePublicationFieldSchema
    })
    .refine(
        (args) => !isEmpty(JSON.parse(JSON.stringify(args))), // is it empty object {} or {field: undefined}? throw if so
        messages.ERR_CAN_NOT_SET_EXCLUDE_PUBLICATION_TO_EMPTY_OBJECT
    );

export const ChallengeExcludeSchema = z.looseObject({
    community: ChallengeExcludeCommunitySchema.optional(),
    postScore: z.number().int().optional(),
    replyScore: z.number().int().optional(),
    postCount: z.number().nonnegative().int().optional(),
    replyCount: z.number().nonnegative().int().optional(),
    firstCommentTimestamp: PKCTimestampSchema.optional(),
    challenges: z.number().nonnegative().int().array().optional(),
    role: CommunityRoleSchema.shape.role.array().optional(),
    address: AuthorAddressSchema.array().optional(),
    rateLimit: z.number().nonnegative().int().optional(),
    rateLimitChallengeSuccess: z.boolean().optional(),
    publicationType: ChallengeExcludePublicationTypeSchema.optional()
});

export const CommunityChallengeSettingSchema = z
    .object({
        // the private settings of the challenge (community.settings.challenges)
        path: z.string().optional(), // (only if name is undefined) the path to the challenge js file, used to get the props ChallengeFile {optionInputs, type, getChallenge}
        name: z.string().optional(), // (only if path is undefined) the challengeName from PKC.challenges to identify it
        options: z.record(z.string(), z.string()).optional(), //{ [optionPropertyName: string]: string } the options to be used to the getChallenge function, all values must be strings for UI ease of use
        // The option names this owner chose to publish in community.challenges[i].publicOptions. Private is
        // the default, so an owner who sets nothing publishes nothing. Only options that are actually set in
        // `options` are emitted. See docs/protocol/challenge-settings.md.
        publicOptions: z.string().array().optional(),
        exclude: ChallengeExcludeSchema.array().nonempty().optional(), // singular because it only has to match 1 exclude, the client must know the exclude setting to configure what challengeCommentCids to send
        description: z.string().optional(), // describe in the frontend what kind of challenge the user will receive when publishing
        pendingApproval: z.boolean().optional()
    })
    .strict()
    .refine((challengeData) => challengeData.path || challengeData.name, "Path or name of challenge has to be defined");

export const GetChallengeArgsSchema = z.object({
    challengeSettings: CommunityChallengeSettingSchema,
    challengeRequestMessage: z.custom<DecryptedChallengeRequestMessageTypeWithCommunityAuthor>(), // no need to validate because extra props may be there
    challengeIndex: z.number().int().nonnegative(),
    community: z.custom<LocalCommunity>()
});

// Loose, not strict: an unknown key here would be a parse error, and a parse error takes community
// startup down. A challenge package that ships a newer optional key (see #283's validateChallengeSettings)
// must still load on an older node, so unknown keys are ignored instead of fatal. The tradeoff is that a
// misspelled *optional* export (e.g. `descriptio`) is now silently ignored rather than reported.
export const ChallengeFileSchema = z.looseObject({
    // the result of the function exported by the challenge file
    optionInputs: ChallengeOptionInputSchema.array().optional(), // the options inputs fields to display to the user
    type: ChallengeFromGetChallengeSchema.shape.type,
    challenge: ChallengeFromGetChallengeSchema.shape.challenge.optional(), // some challenges can be static and asked before the user publishes, like a password for example
    caseInsensitive: z.boolean().optional(), // challenge answer capitalization is ignored, informational only option added by the challenge file
    description: z.string().optional(), // describe what the challenge does to display in the UI
    getChallenge: z.function({
        input: [GetChallengeArgsSchema],
        output: z.promise(ResultOfGetChallengeSchema)
    }),
    // Optional semantic validation of the owner's challengeSettings, for the checks only the challenge can
    // make (does `matches` parse as JSON, does every regexp compile). Core already enforces the mechanical
    // things optionInputs describes, so a challenge with nothing semantic to check omits this.
    // Sync and no network: it runs on every community start, so an async validator hitting a third party
    // would turn that third party's outage into a startup problem. Rejection is a throw of anything at all,
    // so a package needs no pkc-js import; core wraps it in a PKCError with code
    // ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED. See docs/protocol/challenge-authoring.md.
    validateChallengeSettings: z
        .function({ input: [z.object({ challengeSettings: CommunityChallengeSettingSchema })], output: z.void() })
        .optional()
});

export const CommunityChallengeSchema = z.looseObject({
    exclude: ChallengeExcludeSchema.array().nonempty().optional(),
    description: ChallengeFileSchema.shape.description,
    challenge: ChallengeFileSchema.shape.challenge,
    type: ChallengeFileSchema.shape.type,
    caseInsensitive: ChallengeFileSchema.shape.caseInsensitive,
    pendingApproval: z.boolean().optional(),
    // The subset of settings.challenges[i].options the owner opted into publishing, by naming them in
    // settings.challenges[i].publicOptions. Omitted entirely when the owner published nothing.
    publicOptions: z.record(z.string(), z.string()).optional()
});
export const ChallengeFileFactoryArgsSchema = z.object({
    challengeSettings: CommunityChallengeSettingSchema
});

export const ChallengeFileFactorySchema = z.function({ input: [ChallengeFileFactoryArgsSchema], output: ChallengeFileSchema });

// Community actual schemas here

// The anchor (An) of a delegated community: the identity keypair whose private half (As) never
// reaches the node running the community. publicKey here is the B58 IPNS name, the same
// representation community.publicKey uses, NOT the base64 raw key that signer.publicKey and
// encryption.publicKey carry. See docs/protocol/delegated-ipns.md.
// anchor.publicKey becomes the delegated community's address, so an invalid value here would otherwise
// only surface much later, inside peerIdFromString during publishAnchorRecord, long after the community
// was created and keyed by it. Validate it as the IPNS name it has to be, at creation.
export const CommunityAnchorSchema = z
    .object({ publicKey: z.string().refine((arg) => isIpnsName(arg), messages.ERR_ANCHOR_PUBLIC_KEY_IS_INVALID) })
    .strict();

export const CommunityIpfsSchema = z
    .object({
        posts: PostsPagesIpfsSchema.optional(),
        modQueue: ModQueuePagesIpfsSchema.optional(),
        challenges: CommunityChallengeSchema.array(),
        signature: JsonSignatureSchema,
        encryption: CommunityEncryptionSchema,
        name: z.string().min(1).optional(), // domain name of the community (e.g. "memes.eth"); address is now instance-only
        // The community's signed anchor claim (#257): present exactly when the community is delegated.
        // The record is signed by the minter, but the identity readers address is the anchor — this
        // field is what lets a reader who reached the record through the minter (or any non-anchor
        // hop) recover the true identity. On a chain load the claim must equal ipnsHops[0], enforced
        // in verifyCommunity. See docs/protocol/delegated-ipns.md.
        anchor: CommunityAnchorSchema.optional(),
        createdAt: PKCTimestampSchema,
        updatedAt: PKCTimestampSchema,
        pubsubTopic: PubsubTopicSchema.optional(),
        statsCid: CidStringSchema,
        protocolVersion: ProtocolVersionSchema,
        postUpdates: z.record(nonNegativeIntStringSchema, CidStringSchema).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        roles: z.record(AuthorAddressSchema, CommunityRoleSchema).optional(),
        rules: z.string().array().optional(),
        lastPostCid: CidStringSchema.optional(),
        lastCommentCid: CidStringSchema.optional(),
        features: CommunityFeaturesSchema.optional(),
        suggested: CommunitySuggestedSchema.optional(),
        flairs: z.record(z.string(), FlairSchema.array()).optional()
    })
    .strict();

export const CommunitySignedPropertyNames = keys(omit(CommunityIpfsSchema.shape, ["signature"]));

// This is object transmitted by RPC server to RPC client when it's fetching a remote community
// When resetInstance is true, community/updateCid are absent — the client should clear its state
export const RpcRemoteCommunityUpdateEventResultSchema = z.object({
    community: CommunityIpfsSchema.loose().optional(),
    resetInstance: z.boolean().optional(),
    runtimeFields: z
        .object({
            updateCid: CidStringSchema.optional(),
            updatingState: z.custom<LocalCommunity["updatingState"]>().optional(),
            newPublicKey: z.string().optional(),
            nameResolved: z.boolean().optional(),
            ipnsHops: z.array(z.string()).optional()
        })
        .passthrough()
});
// At least one of address, name, or publicKey must be provided to identify the community

export const CreateRemoteCommunityOptionsSchema = CommunityIpfsSchema.partial()
    .extend({
        address: CommunityAddressSchema.optional(), // instance-only, computed as name || publicKey if not provided
        publicKey: z.string().min(1).optional(), // B58 IPNS name (e.g. 12D3KooW...)
        posts: CommunityIpfsSchema.shape.posts.or(PostsPagesIpfsSchema.pick({ pageCids: true })),
        updateCid: CidStringSchema.optional()
    })
    .strict()
    .refine((opts) => opts.address || opts.name || opts.publicKey, "At least one of address, name, or publicKey must be provided");

// Local Community schemas

export const CommunitySettingsSchema = z
    .object({
        fetchThumbnailUrls: z.boolean().optional(),
        fetchThumbnailUrlsProxyUrl: z.string().optional(), // TODO should we validate this url?
        challenges: CommunityChallengeSettingSchema.array().optional(), // If empty array it will remove all challenges
        maxPendingApprovalCount: z.number().int().nonnegative().optional(),
        purgeDisapprovedCommentsOlderThan: z.number().int().nonnegative().optional(),
        // Read-only community: don't run the challenge/publication pubsub topic and omit pubsubTopic
        // from the published record, so readers know not to attempt a challenge exchange (issue #229)
        disablePubsubChallengeExchange: z.boolean().optional()
    })
    .strict();

const CommunityRoleToEditSchema = CommunityRoleSchema.or(z.undefined()); // when we pass undefined we're removing the role

const CommunityRolesToEditSchema = z.record(AuthorAddressSchema, CommunityRoleToEditSchema);

export const CommunityEditOptionsSchema = CommunityIpfsSchema.pick({
    flairs: true,
    name: true,
    title: true,
    description: true,
    roles: true,
    rules: true,
    pubsubTopic: true,
    features: true,
    suggested: true
})
    .extend({
        address: CommunityAddressSchema.optional(), // backward compat for community.edit({ address: "domain.eth" })
        settings: CommunitySettingsSchema.optional(),
        roles: CommunityRolesToEditSchema.optional()
    })
    .partial()
    .strict();

// These are the options to create a new local community, provided by user

export const CreateNewLocalCommunityUserOptionsSchema = CommunityEditOptionsSchema.omit({ address: true })
    .extend({
        signer: CreateSignerSchema.optional(),
        // Delegated community: the node generates its own minter signer (Mn/Ms) and this anchor is
        // the community's identity. Mutually exclusive with signer, enforced in pkc.createCommunity
        // rather than here so this schema stays a plain object the parsed-options schema can extend.
        anchor: CommunityAnchorSchema.optional(),
        roles: CommunityIpfsSchema.shape.roles
    })
    .strict();

// These are the options that go straight into _createLocalCommunity, create a new brand local community. This is after parsing of pkc-js
export const CreateNewLocalCommunityParsedOptionsSchema = CreateNewLocalCommunityUserOptionsSchema.extend({
    address: SignerWithAddressPublicKeySchema.shape.address,
    signer: SignerWithAddressPublicKeySchema
}).strict();

// | CreateNewLocalCommunityUserOptions
// | CreateRemoteCommunityOptions
// | RemoteCommunityJsonType
// | CommunityIpfsType
// | InternalCommunityType
// | RemoteCommunity
// | RpcLocalCommunity
// | RpcRemoteCommunity
// | LocalCommunity = {}

export const CreateRemoteCommunityFunctionArgumentSchema = CreateRemoteCommunityOptionsSchema.or(CommunityIpfsSchema.loose());

export const CreateRpcCommunityFunctionArgumentSchema = CreateRemoteCommunityFunctionArgumentSchema.or(
    CreateNewLocalCommunityUserOptionsSchema
);

export const CreateCommunityFunctionArgumentsSchema = CreateNewLocalCommunityUserOptionsSchema.or(
    CreateRemoteCommunityFunctionArgumentSchema
);

// pkc.listCommunities()

export const ListOfCommunitiesSchema = CommunityAddressSchema.array();

// community.export()

export const ExportCommunityUserOptionsSchema = z
    .object({
        includePrivateKey: z.boolean().optional(),
        exportPath: z.string().min(1).optional(),
        signal: z.custom<AbortSignal>((v) => v === undefined || (typeof v === "object" && v !== null && "aborted" in v)).optional()
    })
    .strict();

// community.exportCommunityModLogs()

export const ExportCommunityModLogsOptionsSchema = z.object({
    startTimestamp: z.number().int().optional(),
    endTimestamp: z.number().int().optional(),
    commentCid: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(), // omit for unlimited; must be >= 1 when provided
    order: z.enum(["ASC", "DESC"]).optional() // default "DESC" (newest first), ordered by timestamp
});

export const CommunityExportRecordErrorSchema = z
    .object({
        code: z.string(),
        message: z.string()
    })
    .strict();

// Public per the design: progress is the only state indicator; size/sha256/url present
// when progress === 1; error present when the export failed (cancellation included).
export const CommunityExportRecordSchema = z
    .object({
        exportId: z.string().uuid(),
        name: z.string().optional(),
        publicKey: z.string(),
        includePrivateKey: z.boolean(),
        progress: z.number().min(0).max(1),
        size: z.number().int().nonnegative().optional(),
        sha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        url: z.string().optional(),
        error: CommunityExportRecordErrorSchema.optional()
    })
    .strict()
    .superRefine((rec, ctx) => {
        if (rec.progress !== 1 || rec.error) return;
        for (const field of ["size", "sha256", "url"] as const) {
            if (rec[field] === undefined)
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [field],
                    message: `${field} must be present when progress === 1 and no error is set`
                });
        }
    });

export const CommunityExportRecordsSchema = CommunityExportRecordSchema.array();

// Reserved fields

// TODO should make the array of class props typed
export const CommunityIpfsReservedFields = difference(
    [
        "cid",
        "shortCid",
        "updateCid",
        "shortUpdateCid",
        "shortAddress",
        "nameResolved",
        "ipnsHops",
        "anchor",
        "raw",
        "shortCommunityAddress",
        "deleted",
        "signer",
        "state",
        "clients",
        "startedState",
        "settings",
        "editable",
        "publishingState",
        "updatingState",
        "started",
        "exports",
        // getCommunity() argument, never part of a record (issue #275)
        "abortSignal"
    ],
    keys(CommunityIpfsSchema.shape)
);

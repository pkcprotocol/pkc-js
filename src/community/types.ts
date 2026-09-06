import { z } from "zod";
import { FlairSchema } from "../schema/schema.js";
import {
    ChallengeExcludeSchema,
    ChallengeFileFactoryArgsSchema,
    ChallengeFileFactorySchema,
    CommunityPageSortSettingSchema,
    CommunityPagesSettingsSchema,
    CommunityPageSortSchema,
    CommunityPageSortsSchema,
    PageSortFileSchema,
    PageSortFileFactorySchema,
    PageSortFileFactoryArgsSchema,
    PageSortScopeSchema,
    ChallengeFileSchema,
    ChallengeFromGetChallengeSchema,
    ChallengeResultSchema,
    CommunityAnchorSchema,
    CreateNewLocalCommunityParsedOptionsSchema,
    CreateNewLocalCommunityUserOptionsSchema,
    CreateRemoteCommunityOptionsSchema,
    GetChallengeArgsSchema,
    CommunityChallengeSchema,
    CommunityChallengeSettingSchema,
    CommunityEditOptionsSchema,
    CommunityEncryptionSchema,
    CommunityFeaturesSchema,
    CommunityIpfsSchema,
    CommunityRoleSchema,
    CommunitySettingsSchema,
    CommunitySuggestedSchema,
    RpcRemoteCommunityUpdateEventResultSchema,
    CommunitySignedPropertyNames,
    CommunityRoleNames,
    ExportCommunityUserOptionsSchema,
    ExportCommunityModLogsOptionsSchema,
    CommunityExportRecordSchema
} from "./schema.js";
import { RpcLocalCommunity } from "./rpc-local-community.js";
import { LocalCommunity } from "../runtime/node/community/local-community.js";
import { RemoteCommunity } from "./remote-community.js";
import { RpcRemoteCommunity } from "./rpc-remote-community.js";
import type { JsonOfClass } from "../types.js";
import type { JsonSignature } from "../signer/types.js";
import type {
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeMessageType,
    DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    DecryptedChallengeVerificationMessageType
} from "../pubsub-messages/types.js";
import { PKCError } from "../pkc-error.js";

export type ReplyStats = {
    hourReplyCount: number;
    dayReplyCount: number;
    weekReplyCount: number;
    monthReplyCount: number;
    yearReplyCount: number;
    allReplyCount: number;
};

export type CommunityStats = {
    hourActiveUserCount: number;
    dayActiveUserCount: number;
    weekActiveUserCount: number;
    monthActiveUserCount: number;
    yearActiveUserCount: number;
    allActiveUserCount: number;
    hourPostCount: number;
    dayPostCount: number;
    weekPostCount: number;
    monthPostCount: number;
    yearPostCount: number;
    allPostCount: number;
} & ReplyStats;

export type CommunityFeatures = z.infer<typeof CommunityFeaturesSchema>;

export type CommunitySuggested = z.infer<typeof CommunitySuggestedSchema>;

export type Flair = z.infer<typeof FlairSchema>;

export type CommunityEncryption = z.infer<typeof CommunityEncryptionSchema>;

export type CommunityRole = z.infer<typeof CommunityRoleSchema>;

export type CommunityRoleNameUnion = z.infer<typeof CommunityRoleNames>;

export type RpcRemoteCommunityType = z.infer<typeof RpcRemoteCommunityUpdateEventResultSchema>;

export type CommunityIpfsType = z.infer<typeof CommunityIpfsSchema>;

export interface CommunitySignature extends JsonSignature {
    signedPropertyNames: typeof CommunitySignedPropertyNames;
}

export type CreateRemoteCommunityOptions = z.infer<typeof CreateRemoteCommunityOptionsSchema>;

// The anchor of a delegated community. See docs/protocol/delegated-ipns.md.
export type CommunityAnchor = z.infer<typeof CommunityAnchorSchema>;

// Sequences travel as decimal strings, not numbers: they are IPNS uint64s, they cross the RPC as JSON,
// and a sequence that silently loses precision is a record that can never win.
export interface AnchorPublishPreparation {
    nextSequence: string; // sign this one, never a lower or equal one
    currentAnchorRecordSequence: string; // highest sequence known to this node or the network
    hasPersistedAnchorRecord: boolean; // whether this node itself has ever accepted an anchor record
}

export interface PublishedAnchorRecord {
    sequence: string;
    value: string; // /ipns/<minter>
    anchorPublicKey: string;
}

export type CreateNewLocalCommunityUserOptions = z.infer<typeof CreateNewLocalCommunityUserOptionsSchema>;

// These are the options that go straight into _createLocalCommunity, create a new brand local community. This is after parsing of pkc-js

export type CreateNewLocalCommunityParsedOptions = z.infer<typeof CreateNewLocalCommunityParsedOptionsSchema>;

// or load an already existing community through pkc.createCommunity

export type CreateInstanceOfLocalOrRemoteCommunityOptions = { address: string };

export type CommunityEditOptions = z.infer<typeof CommunityEditOptionsSchema>;

export type Exclude = z.infer<typeof ChallengeExcludeSchema>;

export type CommunityChallenge = z.infer<typeof CommunityChallengeSchema>;

export type CommunityChallengeSetting = z.infer<typeof CommunityChallengeSettingSchema>;

export type Challenge = z.infer<typeof ChallengeFromGetChallengeSchema>;

export type ChallengeInput = z.input<typeof ChallengeFromGetChallengeSchema>;

export type ChallengeResult = z.infer<typeof ChallengeResultSchema>;

export type ChallengeResultInput = z.input<typeof ChallengeResultSchema>;

export type ChallengeFile = z.infer<typeof ChallengeFileSchema>;

export type ChallengeFileInput = z.input<typeof ChallengeFileSchema>;

export type ChallengeFileFactory = z.infer<typeof ChallengeFileFactorySchema>;

export type ChallengeFileFactoryInput = z.input<typeof ChallengeFileFactorySchema>;

export type ChallengeFileFactoryArgs = z.infer<typeof ChallengeFileFactoryArgsSchema>;

export type ChallengeFileFactoryArgsInput = z.input<typeof ChallengeFileFactoryArgsSchema>;

export type GetChallengeArgs = z.infer<typeof GetChallengeArgsSchema>;

export type GetChallengeArgsInput = z.input<typeof GetChallengeArgsSchema>;

export type CommunitySettings = z.infer<typeof CommunitySettingsSchema>;

export type CommunityPageSortSetting = z.infer<typeof CommunityPageSortSettingSchema>;

export type CommunityPagesSettings = z.infer<typeof CommunityPagesSettingsSchema>;

export type PageSortFile = z.infer<typeof PageSortFileSchema>;

export type PageSortFileInput = z.input<typeof PageSortFileSchema>;

export type PageSortFileFactory = z.infer<typeof PageSortFileFactorySchema>;

export type PageSortFileFactoryInput = z.input<typeof PageSortFileFactorySchema>;

export type PageSortFileFactoryArgs = z.infer<typeof PageSortFileFactoryArgsSchema>;

export type PageSortScope = z.infer<typeof PageSortScopeSchema>;

export type CommunityPageSort = z.infer<typeof CommunityPageSortSchema>;

export type CommunityPageSorts = z.infer<typeof CommunityPageSortsSchema>;

// RPC update events

export type RpcRemoteCommunityUpdateEventResultType = z.infer<typeof RpcRemoteCommunityUpdateEventResultSchema>;

// Community json here

export type RemoteCommunityJson = JsonOfClass<RemoteCommunity>;

export type RpcRemoteCommunityJson = JsonOfClass<RpcRemoteCommunity>;

export type RpcLocalCommunityJson = JsonOfClass<RpcLocalCommunity>;

export type LocalCommunityJson = JsonOfClass<LocalCommunity>;

export type CommunityJson = RemoteCommunityJson | RpcRemoteCommunityJson | RpcLocalCommunityJson | LocalCommunityJson; // after calling JSON.parse(JSON.stringify(communityInstance)), this should be the output

// States here

export type CommunityState = "stopped" | "updating" | "started";

export type CommunityStartedState = "stopped" | "publishing-ipns" | "failed" | "succeeded";

export type CommunityUpdatingState =
    | CommunityStartedState
    | "stopped"
    | "resolving-name"
    | "fetching-ipns"
    | "fetching-ipfs"
    | "failed"
    | "succeeded"
    | "waiting-retry"; // if we loaded a record but didn't end up using it

// Internal community state (in DB)

export interface InternalCommunityRecordBeforeFirstUpdateType extends CreateNewLocalCommunityParsedOptions {
    settings: CommunitySettings;
    challenges: CommunityIpfsType["challenges"];
    pageSorts?: CommunityIpfsType["pageSorts"]; // derived from settings.pages at creation and on every edit (issue #73)
    createdAt: CommunityIpfsType["createdAt"];
    protocolVersion: CommunityIpfsType["protocolVersion"];
    encryption: CommunityIpfsType["encryption"];
    _usingDefaultChallenge: boolean;
    _internalStateUpdateId: string; // uuid v4, everytime we update the internal state of db we will change this id
    _pendingEditProps: Partial<ParsedCommunityEditOptions & { editId: string }>[];
}

export interface InternalCommunityRecordAfterFirstUpdateType extends InternalCommunityRecordBeforeFirstUpdateType, CommunityIpfsType {
    updateCid: string;
    _cidsToUnPin: string[]; // cids that we need to unpin from kubo node
    _mfsPathsToRemove: string[]; // mfs paths that we need to rm from kubo node
    // The pubsubTopic the owner configured, which is NOT always the one in the record above: a
    // community with settings.disablePubsubChallengeExchange publishes no pubsubTopic at all (issue
    // #229), and without this the configured topic would be lost the moment the instance reloaded its
    // internal state from a topic-less record. Kept under a private key so it never reaches the
    // CommunityIpfs half of this record, where an unsigned field would corrupt the record readers see.
    _configuredPubsubTopic?: string;
}

// RPC server transmitting Internal Community records to clients

// Extra local-community properties not present in CommunityIpfsType
export interface RpcLocalCommunityLocalProps {
    signer: Omit<InternalCommunityRecordBeforeFirstUpdateType["signer"], "privateKey">;
    // Present only on a delegated community, where the signer above is the minter and this is the
    // identity the community is addressed by. See docs/protocol/delegated-ipns.md.
    anchor?: CommunityAnchor;
    // Highest anchor sequence the node has accepted for this community, absent when no anchor record
    // has ever been published for it. A delegated community with no value here is not resolvable yet.
    anchorRecordSequence?: string;
    settings: CommunitySettings;
    _usingDefaultChallenge: boolean;
    address: string;
    started: boolean;
    startedState: RpcLocalCommunity["startedState"];
}

// Before first IPNS update: all community data is in localCommunity (no CommunityIpfs record yet)
export interface RpcInternalCommunityRecordBeforeFirstUpdateType {
    localCommunity: Omit<InternalCommunityRecordBeforeFirstUpdateType, "signer" | "_internalStateUpdateId" | "_pendingEditProps"> &
        RpcLocalCommunityLocalProps;
}

// After first IPNS update: community is the signed record, localCommunity has only extras
export interface RpcInternalCommunityRecordAfterFirstUpdateType {
    community: CommunityIpfsType;
    localCommunity: RpcLocalCommunityLocalProps;
    runtimeFields: { updateCid: string; updatingState?: RpcLocalCommunity["updatingState"]; nameResolved?: boolean };
}

export type RpcLocalCommunityUpdateResultType =
    | RpcInternalCommunityRecordBeforeFirstUpdateType
    | RpcInternalCommunityRecordAfterFirstUpdateType;

// This is the object that gets passed to _updateDbInternalState after calling .edit()
export interface ParsedCommunityEditOptions
    extends Omit<CommunityEditOptions, "roles">,
        Pick<InternalCommunityRecordBeforeFirstUpdateType, "_usingDefaultChallenge" | "challenges" | "roles" | "pageSorts"> {}

export interface CommunityEvents {
    challengerequest: (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) => void;
    challenge: (challenge: DecryptedChallengeMessageType) => void;
    challengeanswer: (answer: DecryptedChallengeAnswerMessageType) => void;
    challengeverification: (verification: DecryptedChallengeVerificationMessageType) => void;

    error: (error: PKCError | Error) => void;

    // State changes
    statechange: (newState: RemoteCommunity["state"]) => void;
    updatingstatechange: (newState: RemoteCommunity["updatingState"]) => void;
    startedstatechange: (newState: RpcLocalCommunity["startedState"]) => void;

    update: (updatedCommunity: RemoteCommunity) => void;

    exportschange: (records: CommunityExportRecord[]) => void;

    removeListener: (eventName: string, listener: Function) => void;
}

export type ExportCommunityUserOptions = z.infer<typeof ExportCommunityUserOptionsSchema>;
export type ExportCommunityModLogsOptions = z.infer<typeof ExportCommunityModLogsOptionsSchema>;
export type CommunityExportRecord = z.infer<typeof CommunityExportRecordSchema>;

// Create a helper type to extract the parameters of each event
export type CommunityEventArgs<T extends keyof CommunityEvents> = Parameters<CommunityEvents[T]>;

export type CommunityRpcErrorToTransmit = CommunityEventArgs<"error">[0] & {
    details?: PKCError["details"] & {
        newUpdatingState?: RemoteCommunity["updatingState"];
        newStartedState?: RpcLocalCommunity["startedState"];
    };
};

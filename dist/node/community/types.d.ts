import { z } from "zod";
import { FlairSchema } from "../schema/schema.js";
import { ChallengeExcludeSchema, ChallengeFileFactoryArgsSchema, ChallengeFileFactorySchema, ChallengeFileSchema, ChallengeFromGetChallengeSchema, ChallengeResultSchema, CreateNewLocalCommunityParsedOptionsSchema, CreateNewLocalCommunityUserOptionsSchema, CreateRemoteCommunityOptionsSchema, GetChallengeArgsSchema, CommunityChallengeSchema, CommunityChallengeSettingSchema, CommunityEditOptionsSchema, CommunityEncryptionSchema, CommunityFeaturesSchema, CommunityIpfsSchema, CommunityRoleSchema, CommunitySettingsSchema, CommunitySuggestedSchema, RpcRemoteCommunityUpdateEventResultSchema, CommunitySignedPropertyNames, CommunityRoleNames } from "./schema.js";
import { RpcLocalCommunity } from "./rpc-local-community.js";
import { LocalCommunity } from "../runtime/node/community/local-community.js";
import { RemoteCommunity } from "./remote-community.js";
import { RpcRemoteCommunity } from "./rpc-remote-community.js";
import type { JsonOfClass } from "../types.js";
import type { JsonSignature } from "../signer/types.js";
import type { DecryptedChallengeAnswerMessageType, DecryptedChallengeMessageType, DecryptedChallengeRequestMessageTypeWithCommunityAuthor, DecryptedChallengeVerificationMessageType } from "../pubsub-messages/types.js";
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
export type CreateNewLocalCommunityUserOptions = z.infer<typeof CreateNewLocalCommunityUserOptionsSchema>;
export type CreateNewLocalCommunityParsedOptions = z.infer<typeof CreateNewLocalCommunityParsedOptionsSchema>;
export type CreateInstanceOfLocalOrRemoteCommunityOptions = {
    address: string;
};
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
export type RpcRemoteCommunityUpdateEventResultType = z.infer<typeof RpcRemoteCommunityUpdateEventResultSchema>;
export type RemoteCommunityJson = JsonOfClass<RemoteCommunity>;
export type RpcRemoteCommunityJson = JsonOfClass<RpcRemoteCommunity>;
export type RpcLocalCommunityJson = JsonOfClass<RpcLocalCommunity>;
export type LocalCommunityJson = JsonOfClass<LocalCommunity>;
export type CommunityJson = RemoteCommunityJson | RpcRemoteCommunityJson | RpcLocalCommunityJson | LocalCommunityJson;
export type CommunityState = "stopped" | "updating" | "started";
export type CommunityStartedState = "stopped" | "publishing-ipns" | "failed" | "succeeded";
export type CommunityUpdatingState = CommunityStartedState | "stopped" | "resolving-name" | "fetching-ipns" | "fetching-ipfs" | "failed" | "succeeded" | "waiting-retry";
export interface InternalCommunityRecordBeforeFirstUpdateType extends CreateNewLocalCommunityParsedOptions {
    settings: CommunitySettings;
    challenges: CommunityIpfsType["challenges"];
    createdAt: CommunityIpfsType["createdAt"];
    protocolVersion: CommunityIpfsType["protocolVersion"];
    encryption: CommunityIpfsType["encryption"];
    _usingDefaultChallenge: boolean;
    _internalStateUpdateId: string;
    _pendingEditProps: Partial<ParsedCommunityEditOptions & {
        editId: string;
    }>[];
}
export interface InternalCommunityRecordAfterFirstUpdateType extends InternalCommunityRecordBeforeFirstUpdateType, CommunityIpfsType {
    updateCid: string;
    _cidsToUnPin: string[];
    _mfsPathsToRemove: string[];
}
export interface RpcLocalCommunityLocalProps {
    signer: Omit<InternalCommunityRecordBeforeFirstUpdateType["signer"], "privateKey">;
    settings: CommunitySettings;
    _usingDefaultChallenge: boolean;
    address: string;
    started: boolean;
    startedState: RpcLocalCommunity["startedState"];
}
export interface RpcInternalCommunityRecordBeforeFirstUpdateType {
    localCommunity: Omit<InternalCommunityRecordBeforeFirstUpdateType, "signer" | "_internalStateUpdateId" | "_pendingEditProps"> & RpcLocalCommunityLocalProps;
}
export interface RpcInternalCommunityRecordAfterFirstUpdateType {
    community: CommunityIpfsType;
    localCommunity: RpcLocalCommunityLocalProps;
    runtimeFields: {
        updateCid: string;
        updatingState?: RpcLocalCommunity["updatingState"];
        nameResolved?: boolean;
    };
}
export type RpcLocalCommunityUpdateResultType = RpcInternalCommunityRecordBeforeFirstUpdateType | RpcInternalCommunityRecordAfterFirstUpdateType;
export interface ParsedCommunityEditOptions extends Omit<CommunityEditOptions, "roles">, Pick<InternalCommunityRecordBeforeFirstUpdateType, "_usingDefaultChallenge" | "challenges" | "roles"> {
}
export interface CommunityEvents {
    challengerequest: (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) => void;
    challenge: (challenge: DecryptedChallengeMessageType) => void;
    challengeanswer: (answer: DecryptedChallengeAnswerMessageType) => void;
    challengeverification: (verification: DecryptedChallengeVerificationMessageType) => void;
    error: (error: PKCError | Error) => void;
    statechange: (newState: RemoteCommunity["state"]) => void;
    updatingstatechange: (newState: RemoteCommunity["updatingState"]) => void;
    startedstatechange: (newState: RpcLocalCommunity["startedState"]) => void;
    update: (updatedCommunity: RemoteCommunity) => void;
    removeListener: (eventName: string, listener: Function) => void;
}
export type CommunityEventArgs<T extends keyof CommunityEvents> = Parameters<CommunityEvents[T]>;
export type CommunityRpcErrorToTransmit = CommunityEventArgs<"error">[0] & {
    details?: PKCError["details"] & {
        newUpdatingState?: RemoteCommunity["updatingState"];
        newStartedState?: RpcLocalCommunity["startedState"];
    };
};

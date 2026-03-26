import { z } from "zod";
import { FlairSchema } from "../schema/schema.js";
import {
    ChallengeExcludeSchema,
    ChallengeFileFactoryArgsSchema,
    ChallengeFileFactorySchema,
    ChallengeFileSchema,
    ChallengeFromGetChallengeSchema,
    ChallengeResultSchema,
    CreateNewLocalSubplebbitParsedOptionsSchema,
    CreateNewLocalSubplebbitUserOptionsSchema,
    CreateRemoteSubplebbitOptionsSchema,
    GetChallengeArgsSchema,
    SubplebbitChallengeSchema,
    SubplebbitChallengeSettingSchema,
    SubplebbitEditOptionsSchema,
    SubplebbitEncryptionSchema,
    SubplebbitFeaturesSchema,
    SubplebbitIpfsSchema,
    SubplebbitRoleSchema,
    SubplebbitSettingsSchema,
    SubplebbitSuggestedSchema,
    RpcRemoteSubplebbitUpdateEventResultSchema,
    SubplebbitSignedPropertyNames,
    SubplebbitRoleNames
} from "./schema.js";
import { RpcLocalSubplebbit } from "./rpc-local-subplebbit.js";
import { LocalSubplebbit } from "../runtime/node/subplebbit/local-subplebbit.js";
import { RemoteSubplebbit } from "./remote-subplebbit.js";
import { RpcRemoteSubplebbit } from "./rpc-remote-subplebbit.js";
import type { JsonOfClass } from "../types.js";
import type { JsonSignature } from "../signer/types.js";
import type {
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeMessageType,
    DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor,
    DecryptedChallengeVerificationMessageType
} from "../pubsub-messages/types.js";
import { PlebbitError } from "../plebbit-error.js";

export type ReplyStats = {
    hourReplyCount: number;
    dayReplyCount: number;
    weekReplyCount: number;
    monthReplyCount: number;
    yearReplyCount: number;
    allReplyCount: number;
};

export type SubplebbitStats = {
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

export type SubplebbitFeatures = z.infer<typeof SubplebbitFeaturesSchema>;

export type SubplebbitSuggested = z.infer<typeof SubplebbitSuggestedSchema>;

export type Flair = z.infer<typeof FlairSchema>;

export type SubplebbitEncryption = z.infer<typeof SubplebbitEncryptionSchema>;

export type SubplebbitRole = z.infer<typeof SubplebbitRoleSchema>;

export type SubplebbitRoleNameUnion = z.infer<typeof SubplebbitRoleNames>;

export type RpcRemoteSubplebbitType = z.infer<typeof RpcRemoteSubplebbitUpdateEventResultSchema>;

export type SubplebbitIpfsType = z.infer<typeof SubplebbitIpfsSchema>;

export interface SubplebbitSignature extends JsonSignature {
    signedPropertyNames: typeof SubplebbitSignedPropertyNames;
}

export type CreateRemoteSubplebbitOptions = z.infer<typeof CreateRemoteSubplebbitOptionsSchema>;

export type CreateNewLocalSubplebbitUserOptions = z.infer<typeof CreateNewLocalSubplebbitUserOptionsSchema>;

// These are the options that go straight into _createLocalSub, create a new brand local sub. This is after parsing of plebbit-js

export type CreateNewLocalSubplebbitParsedOptions = z.infer<typeof CreateNewLocalSubplebbitParsedOptionsSchema>;

// or load an already existing sub through plebbit.createSubplebbit

export type CreateInstanceOfLocalOrRemoteSubplebbitOptions = { address: string };

export type SubplebbitEditOptions = z.infer<typeof SubplebbitEditOptionsSchema>;

export type Exclude = z.infer<typeof ChallengeExcludeSchema>;

export type SubplebbitChallenge = z.infer<typeof SubplebbitChallengeSchema>;

export type SubplebbitChallengeSetting = z.infer<typeof SubplebbitChallengeSettingSchema>;

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

export type SubplebbitSettings = z.infer<typeof SubplebbitSettingsSchema>;

// RPC update events

export type RpcRemoteSubplebbitUpdateEventResultType = z.infer<typeof RpcRemoteSubplebbitUpdateEventResultSchema>;

// Subplebbit json here

export type RemoteSubplebbitJson = JsonOfClass<RemoteSubplebbit>;

export type RpcRemoteSubplebbitJson = JsonOfClass<RpcRemoteSubplebbit>;

export type RpcLocalSubplebbitJson = JsonOfClass<RpcLocalSubplebbit>;

export type LocalSubplebbitJson = JsonOfClass<LocalSubplebbit>;

export type SubplebbitJson = RemoteSubplebbitJson | RpcRemoteSubplebbitJson | RpcLocalSubplebbitJson | LocalSubplebbitJson; // after calling JSON.parse(JSON.stringify(subplebbitInstance)), this should be the output

// States here

export type SubplebbitState = "stopped" | "updating" | "started";

export type SubplebbitStartedState = "stopped" | "publishing-ipns" | "failed" | "succeeded";

export type SubplebbitUpdatingState =
    | SubplebbitStartedState
    | "stopped"
    | "resolving-name"
    | "fetching-ipns"
    | "fetching-ipfs"
    | "failed"
    | "succeeded"
    | "waiting-retry"; // if we loaded a record but didn't end up using it

// Internal subplebbit state (in DB)

export interface InternalSubplebbitRecordBeforeFirstUpdateType extends CreateNewLocalSubplebbitParsedOptions {
    settings: SubplebbitSettings;
    challenges: SubplebbitIpfsType["challenges"];
    createdAt: SubplebbitIpfsType["createdAt"];
    protocolVersion: SubplebbitIpfsType["protocolVersion"];
    encryption: SubplebbitIpfsType["encryption"];
    _usingDefaultChallenge: boolean;
    _internalStateUpdateId: string; // uuid v4, everytime we update the internal state of db we will change this id
    _pendingEditProps: Partial<ParsedSubplebbitEditOptions & { editId: string }>[];
}

export interface InternalSubplebbitRecordAfterFirstUpdateType extends InternalSubplebbitRecordBeforeFirstUpdateType, SubplebbitIpfsType {
    updateCid: string;
    _cidsToUnPin: string[]; // cids that we need to unpin from kubo node
    _mfsPathsToRemove: string[]; // mfs paths that we need to rm from kubo node
}

// RPC server transmitting Internal Subplebbit records to clients

export interface RpcInternalSubplebbitRecordBeforeFirstUpdateType
    extends Omit<InternalSubplebbitRecordBeforeFirstUpdateType, "signer" | "_internalStateUpdateId" | "_pendingEditProps"> {
    signer: Omit<InternalSubplebbitRecordBeforeFirstUpdateType["signer"], "privateKey">;
    started: boolean;
    startedState: RpcLocalSubplebbit["startedState"];
}

export interface RpcInternalSubplebbitRecordAfterFirstUpdateType
    extends Omit<
        InternalSubplebbitRecordAfterFirstUpdateType,
        "signer" | "_internalStateUpdateId" | "_cidsToUnPin" | "_mfsPathsToRemove" | "_pendingEditProps" | "updateCid"
    > {
    started: RpcInternalSubplebbitRecordBeforeFirstUpdateType["started"];
    signer: RpcInternalSubplebbitRecordBeforeFirstUpdateType["signer"];
    startedState: RpcLocalSubplebbit["startedState"];
    runtimeFields: Record<string, any>;
}

export type RpcLocalSubplebbitUpdateResultType =
    | RpcInternalSubplebbitRecordBeforeFirstUpdateType
    | RpcInternalSubplebbitRecordAfterFirstUpdateType;

// This is the object that gets passed to _updateDbInternalState after calling .edit()
export interface ParsedSubplebbitEditOptions
    extends Omit<SubplebbitEditOptions, "roles">,
        Pick<InternalSubplebbitRecordBeforeFirstUpdateType, "_usingDefaultChallenge" | "challenges" | "roles"> {}

export interface SubplebbitEvents {
    challengerequest: (request: DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor) => void;
    challenge: (challenge: DecryptedChallengeMessageType) => void;
    challengeanswer: (answer: DecryptedChallengeAnswerMessageType) => void;
    challengeverification: (verification: DecryptedChallengeVerificationMessageType) => void;

    error: (error: PlebbitError | Error) => void;

    // State changes
    statechange: (newState: RemoteSubplebbit["state"]) => void;
    updatingstatechange: (newState: RemoteSubplebbit["updatingState"]) => void;
    startedstatechange: (newState: RpcLocalSubplebbit["startedState"]) => void;

    update: (updatedSubplebbit: RemoteSubplebbit) => void;

    removeListener: (eventName: string, listener: Function) => void;
}

// Create a helper type to extract the parameters of each event
export type SubplebbitEventArgs<T extends keyof SubplebbitEvents> = Parameters<SubplebbitEvents[T]>;

export type SubplebbitRpcErrorToTransmit = SubplebbitEventArgs<"error">[0] & {
    details?: PlebbitError["details"] & {
        newUpdatingState?: RemoteSubplebbit["updatingState"];
        newStartedState?: RpcLocalSubplebbit["startedState"];
    };
};

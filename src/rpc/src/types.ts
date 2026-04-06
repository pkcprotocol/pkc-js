import type { PlebbitError } from "../../pkc-error.js";
import type { Plebbit } from "../../pkc/pkc.js";
import {
    CreatePlebbitWsServerOptionsSchema,
    SetNewSettingsPlebbitWsServerSchema,
    PlebbitWsServerSettingsSerializedSchema
} from "./schema.js";
import { z } from "zod";

export type CreatePlebbitWsServerOptions = z.infer<typeof CreatePlebbitWsServerOptionsSchema>;

export interface PlebbitWsServerClassOptions extends CreatePlebbitWsServerOptions {
    plebbit: Plebbit;
}

export type SetNewSettingsPlebbitWsServer = z.infer<typeof SetNewSettingsPlebbitWsServerSchema>;

export type PlebbitWsServerSettingsSerialized = z.infer<typeof PlebbitWsServerSettingsSerializedSchema>;

export type JsonRpcSendNotificationOptions = {
    method: string;
    result: any;
    subscription: number;
    event: string;
    connectionId: string;
};

export type PlebbitRpcServerEvents = {
    error: (error: PlebbitError | Error) => void;
};

// State tracking for auto-start functionality
export interface RpcSubplebbitState {
    wasStarted: boolean;
    wasExplicitlyStopped: boolean;
}

import type { PKCError } from "../../pkc-error.js";
import type { PKC } from "../../pkc/pkc.js";
import { CreatePKCWsServerOptionsSchema, SetNewSettingsPKCWsServerSchema, PKCWsServerSettingsSerializedSchema } from "./schema.js";
import { z } from "zod";

export type CreatePKCWsServerOptions = z.infer<typeof CreatePKCWsServerOptionsSchema>;

export interface PKCWsServerClassOptions extends CreatePKCWsServerOptions {
    plebbit: PKC;
}

export type SetNewSettingsPKCWsServer = z.infer<typeof SetNewSettingsPKCWsServerSchema>;

export type PKCWsServerSettingsSerialized = z.infer<typeof PKCWsServerSettingsSerializedSchema>;

export type JsonRpcSendNotificationOptions = {
    method: string;
    result: any;
    subscription: number;
    event: string;
    connectionId: string;
};

export type PKCRpcServerEvents = {
    error: (error: PKCError | Error) => void;
};

// State tracking for auto-start functionality
export interface RpcCommunityState {
    wasStarted: boolean;
    wasExplicitlyStopped: boolean;
}

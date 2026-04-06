import { z } from "zod";

import { NameResolverSerializedSchema, PKCParsedOptionsSchema, PKCUserOptionBaseSchema } from "../../schema.js";
import type { Server as HTTPServer } from "http";
import type { Server as HTTPSServer } from "https";
import { ChallengeFileSchema } from "../../community/schema.js";
import type { InputPKCOptions } from "../../types.js";

// Setting up WS

const WsServerClassOptions = z.object({
    port: z.number().int().positive().optional(),
    server: z.custom<HTTPServer | HTTPSServer>().optional()
});

export const CreatePKCWsServerOptionsSchema = z
    .object({
        plebbitOptions: z.custom<InputPKCOptions>().optional(), // no need to validate here, will be validated with await PKC()
        authKey: z.string().optional(),
        startStartedCommunitysOnStartup: z.boolean().optional()
    })
    .merge(WsServerClassOptions)
    .loose();

// rpc WS

export const SetNewSettingsPKCWsServerSchema = z.object({
    plebbitOptions: PKCUserOptionBaseSchema.extend({
        nameResolvers: NameResolverSerializedSchema.array().optional()
    }).loose()
});

export const PKCWsServerSettingsSerializedSchema = z.object({
    plebbitOptions: PKCParsedOptionsSchema.loose(),
    challenges: z.record(
        z.string(),
        ChallengeFileSchema.omit({ getChallenge: true }) // to avoid throwing because of recursive dependency
    )
});

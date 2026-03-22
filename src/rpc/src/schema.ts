import { z } from "zod";

import { NameResolverSerializedSchema, PlebbitParsedOptionsSchema, PlebbitUserOptionBaseSchema } from "../../schema.js";
import type { Server as HTTPServer } from "http";
import type { Server as HTTPSServer } from "https";
import { ChallengeFileSchema } from "../../subplebbit/schema.js";
import type { InputPlebbitOptions } from "../../types.js";

// Setting up WS

const WsServerClassOptions = z.object({
    port: z.number().int().positive().optional(),
    server: z.custom<HTTPServer | HTTPSServer>().optional()
});

export const CreatePlebbitWsServerOptionsSchema = z
    .object({
        plebbitOptions: z.custom<InputPlebbitOptions>().optional(), // no need to validate here, will be validated with await Plebbit()
        authKey: z.string().optional(),
        startStartedSubplebbitsOnStartup: z.boolean().optional()
    })
    .merge(WsServerClassOptions)
    .loose();

// rpc WS

export const SetNewSettingsPlebbitWsServerSchema = z.object({
    plebbitOptions: PlebbitUserOptionBaseSchema.extend({
        nameResolvers: NameResolverSerializedSchema.array().optional()
    }).loose()
});

export const PlebbitWsServerSettingsSerializedSchema = z.object({
    plebbitOptions: PlebbitParsedOptionsSchema.loose(),
    challenges: z.record(
        z.string(),
        ChallengeFileSchema.omit({ getChallenge: true }) // to avoid throwing because of recursive dependency
    )
});

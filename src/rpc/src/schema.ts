import { z } from "zod";

import { NameResolverSerializedSchema, PKCParsedOptionsSchema, PKCUserOptionBaseSchema } from "../../schema.js";
import type { Server as HTTPServer } from "http";
import type { Server as HTTPSServer } from "https";
import { ChallengeFileSchema } from "../../community/schema.js";
import type { InputPKCOptions } from "../../types.js";

// Setting up WS

const WsServerClassOptions = z.object({
    // 0 asks the OS for an ephemeral port (no reserve-then-rebind race); read the bound port from
    // the server's http server after the "listening" event
    port: z.number().int().nonnegative().optional(),
    server: z.custom<HTTPServer | HTTPSServer>().optional()
});

export const CreatePKCWsServerOptionsSchema = z
    .object({
        pkcOptions: z.custom<InputPKCOptions>().optional(), // no need to validate here, will be validated with await PKC()
        authKey: z.string().optional(),
        startStartedCommunitiesOnStartup: z.boolean().optional(),
        // Controls how many communities are auto-started in parallel on boot.
        // 0 or 1 disables parallelism (sequential start). Default: 5
        autoStartConcurrency: z.number().int().nonnegative().optional(),
        // community.export() policy: when false, the server rejects exportCommunity calls with
        // includePrivateKey: true. Default true (private-RPC scope). Public-RPC operators set false.
        allowPrivateKeyExport: z.boolean().optional(),
        // Orphan export-file sweep: on server startup, export sqlite files in <pkcDataPath>/exports/
        // older than this many milliseconds are deleted. Default 86_400_000 (24h). Lower it to
        // reclaim disk sooner; raise it to retain never-downloaded exports for longer.
        // Set it to 0 to disable the sweep entirely — export files are then kept forever and pkc-js
        // never auto-removes them.
        exportFileMaxAgeMs: z.number().int().nonnegative().optional()
    })
    .merge(WsServerClassOptions)
    .loose();

// rpc WS

export const SetNewSettingsPKCWsServerSchema = z.object({
    pkcOptions: PKCUserOptionBaseSchema.extend({
        nameResolvers: NameResolverSerializedSchema.array().optional()
    }).loose()
});

export const PKCWsServerSettingsSerializedSchema = z.object({
    pkcOptions: PKCParsedOptionsSchema.loose(),
    challenges: z.record(
        z.string(),
        // getChallenge is omitted to avoid throwing because of a recursive dependency; validateChallengeSettings
        // is omitted because it is a function that cannot cross the wire and only ever runs community-side.
        ChallengeFileSchema.omit({ getChallenge: true, validateChallengeSettings: true })
    )
});

import { z } from "zod";
import { NameResolverSerializedSchema, PKCParsedOptionsSchema, PKCUserOptionBaseSchema } from "../../schema.js";
import { ChallengeFileSchema } from "../../community/schema.js";
// Setting up WS
const WsServerClassOptions = z.object({
    port: z.number().int().positive().optional(),
    server: z.custom().optional()
});
export const CreatePKCWsServerOptionsSchema = z
    .object({
    pkcOptions: z.custom().optional(), // no need to validate here, will be validated with await PKC()
    authKey: z.string().optional(),
    startStartedCommunitiesOnStartup: z.boolean().optional()
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
    challenges: z.record(z.string(), ChallengeFileSchema.omit({ getChallenge: true }) // to avoid throwing because of recursive dependency
    )
});
//# sourceMappingURL=schema.js.map
import { GetPageParamSchema } from "./schema.js";

export const parsePageCidParams = (params: unknown) => GetPageParamSchema.parse(params);

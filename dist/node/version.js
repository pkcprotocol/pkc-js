import { ProtocolVersionSchema, UserAgentSchema } from "./schema/schema.js";
import { version } from "./generated-version.js";
const protocolVersion = ProtocolVersionSchema.parse("1.0.0");
const pkcJsVersion = version;
const userAgent = UserAgentSchema.parse(`/pkc-js:${pkcJsVersion}/`);
export default {
    PKC_JS_VERSION: pkcJsVersion,
    DB_VERSION: 37,
    PROTOCOL_VERSION: protocolVersion,
    USER_AGENT: userAgent
};
//# sourceMappingURL=version.js.map
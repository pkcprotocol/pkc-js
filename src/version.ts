import { ProtocolVersionSchema, UserAgentSchema } from "./schema/schema.js";
import { version } from "./generated-version.js";

const protocolVersion = ProtocolVersionSchema.parse("1.0.0");
const plebbitJsVersion = version;

const userAgent = UserAgentSchema.parse(`/plebbit-js:${plebbitJsVersion}/`);

export default {
    PLEBBIT_JS_VERSION: plebbitJsVersion,
    DB_VERSION: 37,
    PROTOCOL_VERSION: protocolVersion,
    USER_AGENT: userAgent
};

import { describe, expect, it } from "vitest";
import { normalizeLoggerNamespace } from "../../dist/node/logger.js";

describe("normalizeLoggerNamespace", () => {
    it("renames logger namespaces to PKC naming", () => {
        expect(normalizeLoggerNamespace("pkc-js:PKCRpcClient")).toBe("pkc-js:PKCRpcClient");
        expect(normalizeLoggerNamespace("pkc-js:local-community:start")).toBe("pkc-js:local-community:start");
        expect(normalizeLoggerNamespace("pkc-js:listCommunitysSync")).toBe("pkc-js:listCommunitiesSync");
        expect(normalizeLoggerNamespace("pkc-js-rpc:pkc-ws-server")).toBe("pkc-js-rpc:pkc-ws-server");
        expect(normalizeLoggerNamespace("pkc-react-hooks:pkc-js")).toBe("pkc-react-hooks:pkc-js");
    });
});

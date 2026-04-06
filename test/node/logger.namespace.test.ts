import { describe, expect, it } from "vitest";
import { normalizeLoggerNamespace } from "../../dist/node/logger.js";

describe("normalizeLoggerNamespace", () => {
    it("renames logger namespaces to PKC naming", () => {
        expect(normalizeLoggerNamespace("plebbit-js:PKCRpcClient")).toBe("pkc-js:PKCRpcClient");
        expect(normalizeLoggerNamespace("plebbit-js:local-subplebbit:start")).toBe("pkc-js:local-community:start");
        expect(normalizeLoggerNamespace("plebbit-js:listCommunitysSync")).toBe("pkc-js:listCommunitiesSync");
        expect(normalizeLoggerNamespace("plebbit-js-rpc:plebbit-ws-server")).toBe("pkc-js-rpc:pkc-ws-server");
        expect(normalizeLoggerNamespace("plebbit-react-hooks:plebbit-js")).toBe("pkc-react-hooks:pkc-js");
    });
});

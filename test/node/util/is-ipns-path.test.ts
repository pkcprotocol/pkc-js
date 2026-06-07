import { describe, it, expect } from "vitest";
import { isIpnsPath } from "../../../dist/node/util.js";

describe("isIpnsPath", () => {
    it("accepts a well-formed /ipns/<name> path", () => {
        expect(isIpnsPath("/ipns/12D3KooWExample")).to.be.true;
    });

    it("accepts an /ipns/<name>/<subpath>", () => {
        expect(isIpnsPath("/ipns/12D3KooWExample/posts/1")).to.be.true;
    });

    it("rejects a bare /ipns/ with no name segment", () => {
        // Hardening: a bare "/ipns/" would otherwise flow into split('/')[2] next-hop parsing as
        // an empty name. See src/util.ts isIpnsPath.
        expect(isIpnsPath("/ipns/")).to.be.false;
    });

    it("rejects an /ipfs/<cid> path", () => {
        expect(isIpnsPath("/ipfs/QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR")).to.be.false;
    });

    it("rejects an unrelated string", () => {
        expect(isIpnsPath("ipns/foo")).to.be.false;
        expect(isIpnsPath("")).to.be.false;
    });
});

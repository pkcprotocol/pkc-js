import { afterAll, beforeAll, it, expect } from "vitest";
import { mockPKCWithHeliaConfig } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// The helia/libp2p IPNS resolver (helia-for-pkc.ts) fetches a single record per hop across its routers
// and, when none return a record, throws ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED carrying the name it was
// resolving (currentName) and the per-router errors it collected (routerErrors). This asserts that
// failure shape against a never-published IPNS name. Helia/libp2p-specific (the kubo path resolves via
// kubo, not these routers) and client-side, so it runs once under non-RPC.
describeSkipIfRpc("Helia IPNS resolver router-error aggregation", () => {
    let pkc: PKC;

    beforeAll(async () => {
        pkc = await mockPKCWithHeliaConfig();
    });
    afterAll(async () => {
        if (pkc) await pkc.destroy();
    });

    it("throws ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED with currentName + routerErrors when no router has the record", async () => {
        // A syntactically valid IPNS name that was never published, so every router fails to find it.
        const unpublishedName = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
        try {
            await pkc._clientsManager.resolveIpnsToCidP2P(unpublishedName, { timeoutMs: 15000 });
            expect.fail("resolving a never-published IPNS name should throw");
        } catch (e) {
            const err = e as PKCError;
            expect(err.code).to.equal("ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED");
            const details = err.details as { currentName?: string; routerErrors?: unknown };
            expect(details.currentName).to.equal(unpublishedName);
            // routerErrors aggregates whatever each router threw while trying to fetch the record.
            expect(Array.isArray(details.routerErrors)).to.equal(true);
        }
    });
});

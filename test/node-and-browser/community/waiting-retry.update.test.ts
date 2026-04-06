import {
    getAvailablePKCConfigsToTestAgainst,
    mockPKCToTimeoutFetchingCid,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";

import { _signJson } from "../../../dist/node/signer/signatures.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe.concurrent(`Community and waiting-retry - ${config.name}`, async () => {
        it(`subplebbit.update() emits error if loading subplebbit record times out`, async () => {
            const stallingGateway = "http://127.0.0.1:14000"; // this gateway will wait for 11s before responding
            const plebbit = await config.plebbitInstancePromise({
                plebbitOptions: { ipfsGatewayUrls: [stallingGateway], validatePages: true }
            });
            plebbit._timeouts["subplebbit-ipns"] = 1000; // mocking maximum timeout for subplebbit record loading
            const nonExistentIpns = "12D3KooWHS5A6Ey4V8fLWD64jpPn2EKi4r4btGN6FfkNgMTnfqVa"; // Random non-existent IPNS
            const tempCommunity = await plebbit.createCommunity({ address: nonExistentIpns });
            const waitingRetryErrs: PKCError[] = [];
            tempCommunity.on("error", (err: PKCError | Error) => {
                waitingRetryErrs.push(err as PKCError);
            });
            await tempCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: tempCommunity,
                predicate: async () => waitingRetryErrs.length === 2,
                eventName: "error"
            });
            await tempCommunity.stop();

            for (const err of waitingRetryErrs) {
                expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                for (const gatewayUrl of Object.keys(tempCommunity.clients.ipfsGateways))
                    expect((err.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal("ERR_GATEWAY_TIMED_OUT_OR_ABORTED");
            }
            await plebbit.destroy();
        });
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describe.concurrent(`Community waiting-retry - ${config.name}`, () => {
        let plebbit: PKCType;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it.sequential(`subplebbit.update() emits emits error if resolving subplebbit IPNS times out`, async () => {
            const nonExistentIpns = "12D3KooWHS5A6Ey4V8fLWD64jpPn2EKi4r4btGN6FfkNgMTnfqVa"; // Random non-existent IPNS
            const originalTimeOutIpns = JSON.parse(JSON.stringify(plebbit._timeouts["subplebbit-ipns"]));
            plebbit._timeouts["subplebbit-ipns"] = 100; // mocking maximum timeout for subplebbit record loading

            const tempCommunity = await plebbit.createCommunity({ address: nonExistentIpns });
            const waitingRetryErrs: PKCError[] = [];
            tempCommunity.on("error", (err: PKCError | Error) => {
                waitingRetryErrs.push(err as PKCError);
            });
            await tempCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: tempCommunity,
                predicate: async () => waitingRetryErrs.length === 2,
                eventName: "error"
            });
            await tempCommunity.stop();

            plebbit._timeouts["subplebbit-ipns"] = originalTimeOutIpns;

            // Check that the errors are as expected
            for (const err of waitingRetryErrs) {
                if (config.testConfigCode === "remote-kubo-rpc") expect(err.code).to.equal("ERR_IPNS_RESOLUTION_P2P_TIMEOUT");
                else
                    expect(err.code).to.be.oneOf(
                        ["ERR_IPNS_RESOLUTION_P2P_TIMEOUT", "ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED"],
                        "Error is not as expected: " + JSON.stringify(err)
                    );
            }
        });

        it.sequential(`subplebbit.update() emits waiting-retry if fetching subplebbit CID record times out`, async () => {
            const validIpns = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR"; // this IPNS exists

            // plebbit._timeouts["subplebbit-ipns"] = 100;
            const originalTimeOutIpfs = JSON.parse(JSON.stringify(plebbit._timeouts["subplebbit-ipfs"]));

            plebbit._timeouts["subplebbit-ipfs"] = 100;
            const tempCommunity = await plebbit.createCommunity({ address: validIpns });
            const { cleanUp } = mockPKCToTimeoutFetchingCid(plebbit);
            const waitingRetryErrs: PKCError[] = [];
            tempCommunity.on("error", (err: PKCError | Error) => {
                waitingRetryErrs.push(err as PKCError);
            });
            try {
                await tempCommunity.update();

                await resolveWhenConditionIsTrue({
                    toUpdate: tempCommunity,
                    predicate: async () => waitingRetryErrs.length === 3,
                    eventName: "error"
                });
            } finally {
                cleanUp();
            }

            await tempCommunity.stop();
            plebbit._timeouts["subplebbit-ipfs"] = originalTimeOutIpfs;

            for (const err of waitingRetryErrs) {
                expect(err.code).to.equal("ERR_FETCH_CID_P2P_TIMEOUT");
            }
        });
    });
});

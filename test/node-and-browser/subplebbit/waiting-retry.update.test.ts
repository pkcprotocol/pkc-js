import {
    getAvailablePlebbitConfigsToTestAgainst,
    mockPlebbitToTimeoutFetchingCid,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";

import { _signJson } from "../../../dist/node/signer/signatures.js";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { PlebbitError } from "../../../dist/node/plebbit-error.js";

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe.concurrent(`Subplebbit and waiting-retry - ${config.name}`, async () => {
        it(`subplebbit.update() emits error if loading subplebbit record times out`, async () => {
            const stallingGateway = "http://127.0.0.1:14000"; // this gateway will wait for 11s before responding
            const plebbit = await config.plebbitInstancePromise({
                plebbitOptions: { ipfsGatewayUrls: [stallingGateway], validatePages: true }
            });
            plebbit._timeouts["subplebbit-ipns"] = 1000; // mocking maximum timeout for subplebbit record loading
            const nonExistentIpns = "12D3KooWHS5A6Ey4V8fLWD64jpPn2EKi4r4btGN6FfkNgMTnfqVa"; // Random non-existent IPNS
            const tempSubplebbit = await plebbit.createSubplebbit({ address: nonExistentIpns });
            const waitingRetryErrs: PlebbitError[] = [];
            tempSubplebbit.on("error", (err: PlebbitError | Error) => {
                waitingRetryErrs.push(err as PlebbitError);
            });
            await tempSubplebbit.update();
            await resolveWhenConditionIsTrue({
                toUpdate: tempSubplebbit,
                predicate: async () => waitingRetryErrs.length === 2,
                eventName: "error"
            });
            await tempSubplebbit.stop();

            for (const err of waitingRetryErrs) {
                expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                for (const gatewayUrl of Object.keys(tempSubplebbit.clients.ipfsGateways))
                    expect((err.details.gatewayToError[gatewayUrl] as PlebbitError).code).to.equal("ERR_GATEWAY_TIMED_OUT_OR_ABORTED");
            }
            await plebbit.destroy();
        });
    });
});

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describe.concurrent(`Subplebbit waiting-retry - ${config.name}`, () => {
        let plebbit: PlebbitType;
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

            const tempSubplebbit = await plebbit.createSubplebbit({ address: nonExistentIpns });
            const waitingRetryErrs: PlebbitError[] = [];
            tempSubplebbit.on("error", (err: PlebbitError | Error) => {
                waitingRetryErrs.push(err as PlebbitError);
            });
            await tempSubplebbit.update();
            await resolveWhenConditionIsTrue({
                toUpdate: tempSubplebbit,
                predicate: async () => waitingRetryErrs.length === 2,
                eventName: "error"
            });
            await tempSubplebbit.stop();

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
            const tempSubplebbit = await plebbit.createSubplebbit({ address: validIpns });
            const { cleanUp } = mockPlebbitToTimeoutFetchingCid(plebbit);
            const waitingRetryErrs: PlebbitError[] = [];
            tempSubplebbit.on("error", (err: PlebbitError | Error) => {
                waitingRetryErrs.push(err as PlebbitError);
            });
            try {
                await tempSubplebbit.update();

                await resolveWhenConditionIsTrue({
                    toUpdate: tempSubplebbit,
                    predicate: async () => waitingRetryErrs.length === 3,
                    eventName: "error"
                });
            } finally {
                cleanUp();
            }

            await tempSubplebbit.stop();
            plebbit._timeouts["subplebbit-ipfs"] = originalTimeOutIpfs;

            for (const err of waitingRetryErrs) {
                expect(err.code).to.equal("ERR_FETCH_CID_P2P_TIMEOUT");
            }
        });
    });
});

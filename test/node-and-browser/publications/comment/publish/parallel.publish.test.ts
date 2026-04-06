import { describe, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    createMockedCommunityIpns,
    isPKCFetchingUsingGateways
} from "../../../../../dist/node/test/test-util.js";
import * as cborg from "cborg";
import { io as createSocketClient } from "socket.io-client";
import { convertBase58IpnsNameToBase36Cid } from "../../../../../dist/node/signer/util.js";
import { Buffer } from "buffer";

const MOCK_PUBSUB_URL = "ws://localhost:25963";
const toBase64 = (input: Uint8Array): string => Buffer.from(input).toString("base64");
const normalizeToUint8 = (msg: unknown): Uint8Array | undefined => {
    if (msg instanceof Uint8Array) return msg;
    if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
    if (Array.isArray(msg)) return Uint8Array.from(msg);
    if (typeof msg === "string") {
        try {
            return Buffer.from(msg, "base64");
        } catch {
            return Buffer.from(msg);
        }
    }
    if (msg && typeof msg === "object" && "data" in msg) return normalizeToUint8((msg as { data: unknown }).data);
    return undefined;
};
const waitForMockPubsub = async (timeoutMs = 5000): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        const probe = createSocketClient(MOCK_PUBSUB_URL, {
            transports: ["websocket"],
            reconnection: false,
            timeout: timeoutMs
        });
        const cleanup = () => {
            probe.off("connect", onConnect);
            probe.off("connect_error", onError);
            if (probe.connected) probe.disconnect();
            else probe.close();
        };
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error ?? new Error(`Failed to reach mock pubsub at ${MOCK_PUBSUB_URL}`));
        };
        probe.once("connect", onConnect);
        probe.once("connect_error", onError);
    });

// this hangs on test:browser:chrome
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway", "remote-kubo-rpc", "remote-libp2pjs"] }).map(
    (config) => {
        describe.sequential("comment.publish in parallel potential regressions - " + config.name, () => {
            it.sequential("emits challenge requests for every queued publication even when publishing to a non-existing sub", async () => {
                await waitForMockPubsub().catch((error) => {
                    throw new Error(`Mock pubsub server is not reachable: ${error?.message || error}`);
                });

                const pkc = await config.plebbitInstancePromise(); // this is using mocked pubsub/ipfs client to publish
                pkc.on("error", console.error);

                const stressPublishCount = 100;
                const offlineCommunity = await createMockedCommunityIpns({});
                const offlineSubAddress = offlineCommunity.communityAddress; // this sub is not online so can't respond to messages, although the IPNS record is fetchable

                const challengeRequestIds = new Set();
                const externalPeerChallengeRequests = new Set();

                const externalPeer = createSocketClient(MOCK_PUBSUB_URL, {
                    reconnectionAttempts: 3,
                    reconnectionDelay: 500,
                    transports: ["websocket"],
                    timeout: 5000
                });
                await new Promise<void>((resolve, reject) => {
                    externalPeer.once("connect", () => resolve());
                    externalPeer.once("connect_error", reject);
                });
                externalPeer.on(offlineSubAddress, (msg: unknown) => {
                    const asBytes = normalizeToUint8(msg);
                    if (!asBytes) return;
                    try {
                        const decoded = cborg.decode(asBytes);
                        if (decoded?.type === "CHALLENGEREQUEST" && decoded.challengeRequestId)
                            externalPeerChallengeRequests.add(toBase64(decoded.challengeRequestId));
                    } catch {
                        // ignore decode errors
                    }
                });

                try {
                    const comments = await Promise.all(
                        new Array(stressPublishCount).fill(null).map(async (_, index) => {
                            const comment = await pkc.createComment({
                                communityAddress: offlineSubAddress,
                                title: `parallel publish stress ${index}`,
                                content: `parallel publish stress content ${index}`,
                                signer: await pkc.createSigner()
                            });
                            comment.on("challengerequest", (request) => {
                                challengeRequestIds.add(toBase64(request.challengeRequestId));
                            });
                            return comment;
                        })
                    );

                    await Promise.all([
                        ...comments.map((comment) => comment.publish()),
                        new Promise<void>((resolve, reject) => {
                            const timeout = setTimeout(
                                () =>
                                    reject(
                                        new Error(
                                            `Timed out waiting for mock pubsub challenge requests on ${offlineSubAddress} after ${stressPublishCount} publishes`
                                        )
                                    ),
                                20000
                            );
                            externalPeer.on(offlineSubAddress, () => {
                                if (externalPeerChallengeRequests.size >= stressPublishCount) {
                                    clearTimeout(timeout);
                                    resolve();
                                }
                            });
                        })
                    ]); // should publish comments  but not get a response

                    expect(challengeRequestIds.size).to.greaterThanOrEqual(
                        stressPublishCount,
                        "Not every publication emitted a challenge request"
                    );
                    expect(externalPeerChallengeRequests.size).to.equal(
                        stressPublishCount,
                        "External peer did not receive all challenge requests"
                    );

                    await Promise.all(comments.map((comment) => comment.stop()));
                } finally {
                    externalPeer.disconnect();
                    await pkc.destroy();
                }
            });

            it("resolves the community IPNS record only once when multiple publishes start in parallel", async () => {
                const localPKC = await config.plebbitInstancePromise({});
                localPKC.on("error", console.error);
                const stressPublishCount = typeof globalThis.window !== "undefined" ? 20 : 350;
                const randomSub = await createMockedCommunityIpns({}); // sub has a reachable IPNS but is not online

                const usesGateways = isPKCFetchingUsingGateways(localPKC);
                const isRemoteIpfsGatewayConfig = isPKCFetchingUsingGateways(localPKC);
                const shouldMockFetchForIpns = isRemoteIpfsGatewayConfig && typeof globalThis.fetch === "function";

                const targetAddressForGatewayIpnsUrl = convertBase58IpnsNameToBase36Cid(randomSub.communityAddress);
                let fetchSpy: MockInstance | undefined;
                let nameResolveSpy: MockInstance | undefined;

                if (!usesGateways) {
                    const p2pClient =
                        Object.keys(localPKC.clients.kuboRpcClients).length > 0
                            ? Object.values(localPKC.clients.kuboRpcClients)[0]._client
                            : Object.keys(localPKC.clients.libp2pJsClients).length > 0
                              ? Object.values(localPKC.clients.libp2pJsClients)[0].heliaWithKuboRpcClientFunctions
                              : undefined;
                    if (!p2pClient?.name?.resolve) {
                        throw new Error("Expected p2p client like kubo or helia RPC client with name.resolve for this test");
                    }
                    nameResolveSpy = vi.spyOn(p2pClient.name, "resolve");
                } else if (shouldMockFetchForIpns) {
                    fetchSpy = vi.spyOn(globalThis, "fetch");
                }

                try {
                    expect(localPKC._updatingCommunitys.size()).to.equal(0);

                    const comments = await Promise.all(
                        new Array(stressPublishCount).fill(null).map(async (_, index) =>
                            localPKC.createComment({
                                communityAddress: randomSub.communityAddress,
                                title: `parallel publish cache regression ${index}`,
                                content: `parallel publish cache regression content ${index}`,
                                signer: await localPKC.createSigner()
                            })
                        )
                    );

                    await Promise.all(comments.map((comment) => comment.publish()));

                    await new Promise((resolve) => setTimeout(resolve, 5000));

                    expect(localPKC._updatingCommunitys.size()).to.equal(0);

                    const resolveCallsCount = fetchSpy
                        ? fetchSpy.mock.calls.filter(([input]: unknown[]) => {
                              const url = typeof input === "string" ? input : (input as { url?: string })?.url;
                              return typeof url === "string" && url.includes("/ipns/" + targetAddressForGatewayIpnsUrl);
                          }).length
                        : nameResolveSpy!.mock.calls.filter((callArgs: unknown[]) => callArgs[0] === randomSub.communityAddress).length;

                    expect(resolveCallsCount).to.equal(1, "Publishing to the same subplebbit should only resolve IPNS once");
                    await Promise.all(comments.map((comment) => comment.stop()));
                } finally {
                    if (nameResolveSpy) nameResolveSpy.mockRestore();
                    if (fetchSpy) fetchSpy.mockRestore();
                    await localPKC.destroy();
                }
            });
        });
    }
);

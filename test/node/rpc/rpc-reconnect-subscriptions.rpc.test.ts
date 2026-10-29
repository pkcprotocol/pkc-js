// Reproduces issue #425: when the websocket between a PKC RPC client and the RPC server drops,
// rpc-websockets reconnects on its own and PKCRpcClient goes stopped -> connected again, but every
// subscription made before the drop is dead. The server bound each subscription to the old
// connection and cleaned it up on disconnect (_cleanUpDisconnectedClient), and the client never
// re-issues the subscribe calls on the new connection. On top of that, the client's raw
// notification handler is bound to the old socket object, which rpc-websockets replaces on
// reconnect. The instances keep their state and emit nothing, so the consumer cannot tell.
//
// The contract asserted: as long as the client can reconnect, an earlier update(), start() or
// subscription keeps emitting its events, with no action from the consumer. An error is not
// enough. The one exception is a publication in flight: the server stops it on disconnect and
// re-publishing behind the user's back would start a challenge exchange they never saw, so it must
// fail loudly with ERR_RPC_PUBLICATION_LOST_WITH_CONNECTION and publishingState "failed".
//
// One case per subscription type the RPC server exposes:
//   communityUpdateSubscribe  community.update()
//   commentUpdateSubscribe    comment.update()
//   startCommunity            community.start()
//   publishComment, publishVote, publishCommentEdit, publishCommentModeration,
//   publishCommunityEdit      publication.publish()
//   communitiesSubscribe      pkc.communities
//   settingsSubscribe         pkcRpcClient.settings
//   exportsSubscribe          community.export() / community.exports
//
// Each case runs in two modes. Both prove the subscription is live first, then cut the connection
// server-side (terminating the socket, which from the server's side is the same as a network drop,
// a server restart or a laptop suspend):
//   live     the client reconnects, then the event happens. It must be delivered.
//   backlog  the event happens while the client is disconnected (auto-reconnect is held off until
//            the server has emitted it), then the client reconnects. It must still be delivered,
//            as the latest state: the server keeps no events for a dropped connection, the
//            re-issued subscription's snapshot carries the state instead.
//
// A start() is re-established without ever overriding a stop it did not make: a community someone
// else stopped, while this client was connected or while it was away, stays stopped and the client
// is told so. One the server lost without a stop (a server restart) is started again.
//
// The last block covers the connection itself: the client keeps retrying past rpc-websockets'
// default of 5 attempts (a laptop waking from suspend may take a while to get its network back),
// and pkc.destroy() leaves no connection or pending reconnect behind, whether it runs while
// connected or during the retry backoff.
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import type { Server as HTTPServer } from "node:http";
import PKC from "../../../dist/node/index.js";
import {
    mockRpcServerPKC,
    publishRandomPost,
    publishRandomReply,
    expectCommunityListed,
    findListedCommunity
} from "../../../dist/node/test/test-util.js";
import { createInProcessRpcServer, pollUntil, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { describeIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type {
    ChallengeFileInput,
    ChallengeInput,
    ChallengeResultInput,
    GetChallengeArgsInput
} from "../../../dist/node/community/types.js";

const RPC_AUTH_KEY = "test-rpc-reconnect-subscriptions";

// How long a subscription gets after the reconnect to deliver the event. The server-side
// communities publish every second, so a live subscription delivers well within this window.
const DELIVERY_WINDOW_MS = 20_000;

type Mode = "live" | "backlog";
type Outcome = "delivered" | "errored" | "silent";

type RpcServerInternals = {
    _startedCommunities: Record<string, unknown>;
    _getRpcStateDb: () => { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } | undefined;
    stopCommunity: (params: unknown[]) => Promise<unknown>;
    rpcWebsockets: {
        wss: { clients: Set<{ terminate: () => void }>; on: (event: "connection", listener: () => void) => unknown };
    };
    _httpServer: HTTPServer;
    _pendingDisconnectionCleanups: Set<Promise<void>>;
    _exportCommunityInstances: Map<string, LocalCommunity>;
    getStartedCommunity: (address: string) => Promise<LocalCommunity>;
};

type RpcClientInternals = {
    state: string;
    on: (event: "statechange", listener: (state: string) => void) => unknown;
    removeListener: (event: "statechange", listener: (state: string) => void) => unknown;
    _webSocketClient: { setAutoReconnect: (reconnect: boolean) => void; connect: () => void; getCurrentReconnects: () => number };
    _reconnectBaseIntervalMs: number;
    _reconnectMaxIntervalMs: number;
};

type ErrorWithCode = Error & { code?: string };

type ErrorEmitter = { on: (event: "error", listener: (error: Error) => void) => unknown };

// What a case does once its subscription is proven live
type ReconnectCase = {
    // Make the event happen on the server and resolve once the server has emitted it
    trigger: () => Promise<void>;
    delivered: () => boolean;
    cleanup: () => Promise<void>;
    // Set when the case must fail loudly instead of delivering (a publication in flight)
    expectedErrorCode?: string;
};

// A challenge the test can hold server-side. Disarmed it passes every request outright, so the
// setup publications go through. Armed, getChallenge parks until the test releases it, which pins
// the moment the community has received the request but not yet answered with a challenge
const gate: { armed: boolean; entered: boolean; release?: () => void } = { armed: false, entered: false };
const gatedChallenge = (): ChallengeFileInput => {
    const type: ChallengeInput["type"] = "text/plain";
    const challenge = "1+1=?";
    const getChallenge = async ({
        challengeRequestMessage,
        challengeIndex
    }: GetChallengeArgsInput): Promise<ChallengeInput | ChallengeResultInput> => {
        if (!gate.armed) return { success: true };
        const answer = challengeRequestMessage?.challengeAnswers?.[challengeIndex];
        if (answer !== undefined) return answer === "2" ? { success: true } : { success: false, error: "Wrong answer." };
        const released = new Promise<void>((resolve) => (gate.release = resolve));
        gate.entered = true;
        await released;
        return {
            challenge,
            verify: async (a: string): Promise<ChallengeResultInput> =>
                a === "2" ? { success: true } : { success: false, error: "Wrong answer." },
            type
        };
    };
    return { getChallenge, type, challenge, description: "Held by the #425 reconnect test until it releases it." };
};

describeIfRpc("RPC subscriptions after the websocket auto-reconnects (#425)", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    // Started by serverPKC directly: target of the update, comment-update, communities and exports cases
    let updatingCommunity: LocalCommunity;
    let updatingPost: Comment;
    // Started by serverPKC with the gated challenge: target of the publication cases
    let challengeCommunity: LocalCommunity;
    let challengePost: Comment;
    // Owner of challengeCommunity and author of challengePost, so every publication type is allowed
    let publisherSigner: SignerType;

    const clients: PKCType[] = [];

    const serverInternals = () => rpcServer as unknown as RpcServerInternals;
    const rpcClientOf = (client: PKCType) => client.clients.pkcRpcClients[rpcUrl] as unknown as RpcClientInternals;

    async function createClient(): Promise<PKCType> {
        const client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        clients.push(client);
        return client;
    }

    // Cut every client connection from the server side and wait until the client has seen the
    // close and the server has finished cleaning up the old connection's subscriptions. In backlog
    // mode auto-reconnect is held off so the event can happen while the client is disconnected;
    // the returned reconnect() lets it reconnect and waits until it is connected again
    async function dropConnection(client: PKCType, mode: Mode): Promise<{ reconnect: () => Promise<void> }> {
        const rpcClient = rpcClientOf(client);
        const states: string[] = [];
        const onStateChange = (state: string) => states.push(state);
        rpcClient.on("statechange", onStateChange);
        if (mode === "backlog") rpcClient._webSocketClient.setAutoReconnect(false);
        for (const socket of serverInternals().rpcWebsockets.wss.clients) socket.terminate();
        await pollUntil(() => states.includes("stopped"), { timeoutMs: 15_000 });
        expect(states).toContain("stopped");
        await Promise.all([...serverInternals()._pendingDisconnectionCleanups]);

        return {
            reconnect: async () => {
                try {
                    if (mode === "backlog") {
                        rpcClient._webSocketClient.setAutoReconnect(true);
                        rpcClient._webSocketClient.connect();
                    }
                    await pollUntil(() => rpcClient.state === "connected", { timeoutMs: 15_000 });
                } finally {
                    rpcClient.removeListener("statechange", onStateChange);
                }
                expect(rpcClient.state).toBe("connected");
            }
        };
    }

    // Prove-live is done by the case's setup; this runs the drop, the event and the reconnect in
    // the order the mode asks for, then waits for delivery
    async function runReconnectCase(opts: { client: PKCType; mode: Mode; errorEmitters: ErrorEmitter[]; testCase: ReconnectCase }) {
        const { client, mode, testCase } = opts;
        const errors: ErrorWithCode[] = [];
        // Attached before the drop: a publication fails as the connection closes
        for (const emitter of opts.errorEmitters) emitter.on("error", (error) => errors.push(error));
        try {
            const { reconnect } = await dropConnection(client, mode);
            if (mode === "live") {
                await reconnect();
                await testCase.trigger();
            } else {
                await testCase.trigger();
                await reconnect();
            }
            if (testCase.expectedErrorCode) {
                const code = testCase.expectedErrorCode;
                await pollUntil(() => errors.some((e) => e.code === code), { timeoutMs: DELIVERY_WINDOW_MS });
                expect({ errorCodes: errors.map((e) => e.code), delivered: testCase.delivered() }).toEqual({
                    errorCodes: [code],
                    delivered: false
                });
                return;
            }
            await pollUntil(() => testCase.delivered(), { timeoutMs: DELIVERY_WINDOW_MS });
            const outcome: Outcome = testCase.delivered() ? "delivered" : errors.length > 0 ? "errored" : "silent";
            expect({ outcome, errors: errors.map((e) => e.message) }).toEqual({ outcome: "delivered", errors: [] });
        } finally {
            await testCase.cleanup();
        }
    }

    // Resolves once the server-side community has published a record newer than the one it had
    async function editAndAwaitPublish(community: LocalCommunity, edit: Parameters<LocalCommunity["edit"]>[0]) {
        const updatedAtBefore = community.updatedAt ?? 0;
        await community.edit(edit);
        await pollUntil(() => (community.updatedAt ?? 0) > updatedAtBefore, { timeoutMs: 30_000 });
        expect(community.updatedAt ?? 0).toBeGreaterThan(updatedAtBefore);
    }

    beforeAll(async () => {
        serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("pkc-rpc-reconnect-subscriptions") });
        serverPKC.settings.challenges = { ...serverPKC.settings.challenges, "reconnect-gate": gatedChallenge };

        updatingCommunity = <LocalCommunity>await serverPKC.createCommunity({});
        await updatingCommunity.edit({ settings: { challenges: [] } });
        await updatingCommunity.start();
        await pollUntil(() => typeof updatingCommunity.updatedAt === "number", { timeoutMs: 60_000 });
        updatingPost = await publishRandomPost({ communityAddress: updatingCommunity.address, pkc: serverPKC });

        publisherSigner = await serverPKC.createSigner();
        challengeCommunity = <LocalCommunity>await serverPKC.createCommunity({});
        await challengeCommunity.edit({
            settings: { challenges: [{ name: "reconnect-gate" }] },
            roles: { [publisherSigner.address]: { role: "owner" } }
        });
        await challengeCommunity.start();
        await pollUntil(() => typeof challengeCommunity.updatedAt === "number", { timeoutMs: 60_000 });
        challengePost = await publishRandomPost({
            communityAddress: challengeCommunity.address,
            pkc: serverPKC,
            postProps: { signer: publisherSigner }
        });

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));
    });

    afterAll(async () => {
        gate.armed = false;
        gate.release?.();
        for (const client of clients) if (!client.destroyed) await client.destroy();
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    const modes: Mode[] = ["live", "backlog"];

    for (const mode of modes) {
        describe(`${mode}: the event happens ${mode === "live" ? "after the reconnect" : "while disconnected"}`, () => {
            it("community.update() delivers the new record (communityUpdateSubscribe)", async () => {
                const client = await createClient();
                const community = await client.createCommunity({ address: updatingCommunity.address });
                await community.update();

                const titleBeforeDrop = `before drop ${Date.now()}`;
                await updatingCommunity.edit({ title: titleBeforeDrop });
                await pollUntil(() => community.title === titleBeforeDrop, { timeoutMs: 30_000 });
                expect(community.title).toBe(titleBeforeDrop);

                const titleAfterDrop = `after drop ${mode} ${Date.now()}`;
                await runReconnectCase({
                    client,
                    mode,
                    errorEmitters: [community],
                    testCase: {
                        trigger: () => editAndAwaitPublish(updatingCommunity, { title: titleAfterDrop }),
                        delivered: () => community.title === titleAfterDrop,
                        cleanup: () => community.stop()
                    }
                });
            });

            it("comment.update() delivers the new CommentUpdate (commentUpdateSubscribe)", async () => {
                const client = await createClient();
                const comment = await client.createComment({ cid: updatingPost.cid! });
                await comment.update();
                await pollUntil(() => typeof comment.updatedAt === "number", { timeoutMs: 30_000 });
                expect(comment.updatedAt).toBeTypeOf("number");
                const replyCountBeforeDrop = comment.replyCount ?? 0;

                // Watches the same post server-side, so the trigger knows when the new CommentUpdate is out
                const serverSideComment = await serverPKC.createComment({ cid: updatingPost.cid! });
                await serverSideComment.update();

                await runReconnectCase({
                    client,
                    mode,
                    errorEmitters: [comment],
                    testCase: {
                        trigger: async () => {
                            await publishRandomReply({
                                parentComment: updatingPost as unknown as CommentIpfsWithCidDefined,
                                pkc: serverPKC
                            });
                            await pollUntil(() => (serverSideComment.replyCount ?? 0) > replyCountBeforeDrop, { timeoutMs: 30_000 });
                            expect(serverSideComment.replyCount ?? 0).toBeGreaterThan(replyCountBeforeDrop);
                        },
                        delivered: () => (comment.replyCount ?? 0) > replyCountBeforeDrop,
                        cleanup: async () => {
                            await comment.stop();
                            await serverSideComment.stop();
                        }
                    }
                });
            });

            it("a community started over RPC delivers its new record (startCommunity)", async () => {
                const communityToStart = <LocalCommunity>await serverPKC.createCommunity({});
                await communityToStart.edit({ settings: { challenges: [] } });

                const client = await createClient();
                const community = <RpcLocalCommunity>await client.createCommunity({ address: communityToStart.address });
                await community.start();
                const serverSideStarted = await serverInternals().getStartedCommunity(communityToStart.address);

                const titleBeforeDrop = `before drop ${Date.now()}`;
                await serverSideStarted.edit({ title: titleBeforeDrop });
                await pollUntil(() => community.title === titleBeforeDrop, { timeoutMs: 30_000 });
                expect(community.title).toBe(titleBeforeDrop);

                // Edited server-side, not through community.edit(): the editCommunity response would
                // carry the new title back without needing the start subscription
                const titleAfterDrop = `after drop ${mode} ${Date.now()}`;
                await runReconnectCase({
                    client,
                    mode,
                    errorEmitters: [community],
                    testCase: {
                        trigger: () => editAndAwaitPublish(serverSideStarted, { title: titleAfterDrop }),
                        delivered: () => community.title === titleAfterDrop,
                        cleanup: () => community.stop().catch((): undefined => undefined)
                    }
                });
            });

            type PublicationLike = ErrorEmitter & {
                on: (event: "challenge" | "challengeverification", listener: () => void) => unknown;
                publish: () => Promise<void>;
                stop: () => Promise<void>;
                publishingState: string;
            };
            const publicationCases: { rpcMethod: string; create: (client: PKCType, signer: SignerType) => Promise<unknown> }[] = [
                {
                    rpcMethod: "publishComment",
                    create: (client, signer) =>
                        client.createComment({
                            communityAddress: challengeCommunity.address,
                            signer,
                            title: `#425 reconnect post ${Date.now()}`,
                            content: "published right before the websocket drops"
                        })
                },
                {
                    rpcMethod: "publishVote",
                    create: (client, signer) =>
                        client.createVote({ communityAddress: challengeCommunity.address, signer, commentCid: challengePost.cid!, vote: 1 })
                },
                {
                    rpcMethod: "publishCommentEdit",
                    create: (client, signer) =>
                        client.createCommentEdit({
                            communityAddress: challengeCommunity.address,
                            signer,
                            commentCid: challengePost.cid!,
                            content: `#425 reconnect edit ${Date.now()}`
                        })
                },
                {
                    rpcMethod: "publishCommentModeration",
                    create: (client, signer) =>
                        client.createCommentModeration({
                            communityAddress: challengeCommunity.address,
                            signer,
                            commentCid: challengePost.cid!,
                            commentModeration: { pinned: true }
                        })
                },
                {
                    rpcMethod: "publishCommunityEdit",
                    create: (client, signer) =>
                        client.createCommunityEdit({
                            communityAddress: challengeCommunity.address,
                            signer,
                            communityEdit: { description: `#425 reconnect community edit ${Date.now()}` }
                        })
                }
            ];

            for (const { rpcMethod, create } of publicationCases) {
                it(`a publication waiting for its challenge fails loudly instead of going silent (${rpcMethod})`, async () => {
                    const client = await createClient();
                    const signer = await client.createSigner({ privateKey: publisherSigner.privateKey, type: "ed25519" });
                    const publication = <PublicationLike>await create(client, signer);
                    let challengeReceived = false;
                    publication.on("challenge", () => (challengeReceived = true));
                    publication.on("challengeverification", () => (challengeReceived = true));

                    gate.armed = true;
                    gate.entered = false;
                    await publication.publish();
                    // The community holds the request: the server-side publication is alive and
                    // waiting for the challenge it forwards over the publish subscription
                    await pollUntil(() => gate.entered, { timeoutMs: 30_000 });
                    expect(gate.entered).toBe(true);

                    await runReconnectCase({
                        client,
                        mode,
                        errorEmitters: [publication],
                        testCase: {
                            trigger: async () => {
                                const challengeSent = new Promise<void>((resolve) => challengeCommunity.once("challenge", () => resolve()));
                                gate.release?.();
                                await challengeSent;
                            },
                            delivered: () => challengeReceived,
                            expectedErrorCode: "ERR_RPC_PUBLICATION_LOST_WITH_CONNECTION",
                            cleanup: async () => {
                                expect(publication.publishingState).toBe("failed");
                                gate.armed = false;
                                gate.release?.();
                                await publication.stop().catch((): undefined => undefined);
                            }
                        }
                    });
                });
            }

            it("pkc.communities delivers the new list (communitiesSubscribe)", async () => {
                const client = await createClient();
                await pollUntil(
                    () =>
                        findListedCommunity({ pkc: client, publicKey: updatingCommunity.publicKey! })?.address ===
                        updatingCommunity.address,
                    { timeoutMs: 30_000 }
                );
                expectCommunityListed({
                    pkc: client,
                    publicKey: updatingCommunity.publicKey!,
                    address: updatingCommunity.address,
                    name: updatingCommunity.name
                });

                let newCommunity: { publicKey: string; address: string; name: string | undefined } | undefined;
                await runReconnectCase({
                    client,
                    mode,
                    errorEmitters: [client],
                    testCase: {
                        trigger: async () => {
                            const created = await serverPKC.createCommunity({});
                            const listed = { publicKey: created.publicKey!, address: created.address, name: created.name };
                            newCommunity = listed;
                            await pollUntil(
                                () => findListedCommunity({ pkc: serverPKC, publicKey: listed.publicKey })?.address === listed.address,
                                {
                                    timeoutMs: 15_000
                                }
                            );
                            expectCommunityListed({ pkc: serverPKC, ...listed });
                        },
                        delivered: () =>
                            Boolean(
                                newCommunity &&
                                    findListedCommunity({ pkc: client, publicKey: newCommunity.publicKey })?.address ===
                                        newCommunity.address
                            ),
                        cleanup: async () => undefined
                    }
                });
            });

            it("the RPC client's settings deliver the new settings (settingsSubscribe)", async () => {
                const client = await createClient();
                // The RPC server's settings live on the RPC client, not on the PKC instance
                const rpcClient = client.clients.pkcRpcClients[rpcUrl];
                await pollUntil(() => Boolean(rpcClient.settings?.challenges?.["reconnect-gate"]), { timeoutMs: 30_000 });
                expect(rpcClient.settings?.challenges?.["reconnect-gate"]).toBeDefined();

                const probeName = `reconnect-probe-${mode}`;
                await runReconnectCase({
                    client,
                    mode,
                    errorEmitters: [client],
                    testCase: {
                        trigger: async () => {
                            serverPKC.settings.challenges = { ...serverPKC.settings.challenges, [probeName]: gatedChallenge };
                            await rpcServer.notifySettingsChange();
                        },
                        delivered: () => Boolean(rpcClient.settings?.challenges?.[probeName]),
                        cleanup: async () => undefined
                    }
                });
            });

            it("community.exports delivers the finished export (exportsSubscribe)", async () => {
                const client = await createClient();
                const community = <RpcLocalCommunity>await client.createCommunity({ address: updatingCommunity.address });

                const exportIsDone = (exportId: string | undefined) => {
                    const record = community.exports.find((r) => r.exportId === exportId);
                    return Boolean(record && (record.progress === 1 || record.error));
                };
                const { exportId: exportBeforeDrop } = await community.export();
                await pollUntil(() => exportIsDone(exportBeforeDrop), { timeoutMs: 30_000 });
                expect(exportIsDone(exportBeforeDrop)).toBe(true);

                // Started on the server's canonical export instance rather than with
                // community.export(): in backlog mode the client has no connection to call through,
                // and the completion of either kind only reaches the client over the exports subscription
                const serverSideExportInstance = serverInternals()._exportCommunityInstances.get(updatingCommunity.address);
                if (!serverSideExportInstance) throw new Error("Test setup failed: the server has no export instance for the community");
                let exportAfterDrop: string | undefined;
                await runReconnectCase({
                    client,
                    mode,
                    errorEmitters: [community],
                    testCase: {
                        trigger: async () => {
                            exportAfterDrop = (await serverSideExportInstance.export()).exportId;
                            const serverSideDone = () => {
                                const record = serverSideExportInstance.exports.find((r) => r.exportId === exportAfterDrop);
                                return Boolean(record && (record.progress === 1 || record.error));
                            };
                            await pollUntil(serverSideDone, { timeoutMs: 30_000 });
                            expect(serverSideDone()).toBe(true);
                        },
                        delivered: () => exportIsDone(exportAfterDrop),
                        cleanup: async () => undefined
                    }
                });
            });
        });
    }

    describe("start() across a reconnect never undoes a stop it did not make", () => {
        // Resolves to the server's persisted auto-start record for the community
        const persistedStartState = (address: string) =>
            serverInternals()
                ._getRpcStateDb()
                ?.prepare("SELECT wasStarted, wasExplicitlyStopped FROM community_states WHERE address = ?")
                .get(address) as { wasStarted: number; wasExplicitlyStopped: number } | undefined;

        async function startCommunityOverRpc() {
            const communityToStart = <LocalCommunity>await serverPKC.createCommunity({});
            await communityToStart.edit({ settings: { challenges: [] } });
            const client = await createClient();
            const community = <RpcLocalCommunity>await client.createCommunity({ address: communityToStart.address });
            await community.start();
            await pollUntil(() => typeof community.updatedAt === "number", { timeoutMs: 30_000 });
            expect(community.updatedAt).toBeTypeOf("number");
            return { client, community, address: communityToStart.address, publicKey: communityToStart.publicKey! };
        }

        it("a community stopped by someone else while this client was connected stays stopped after the reconnect", async () => {
            const { client, community, address, publicKey } = await startCommunityOverRpc();
            await serverInternals().stopCommunity([{ publicKey }]);
            await pollUntil(() => community.startedState === "stopped", { timeoutMs: 15_000 });
            expect(community.startedState).toBe("stopped");

            const { reconnect } = await dropConnection(client, "live");
            await reconnect();
            // Long enough for a re-issued start to have reached the server and started the community
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            expect({
                runningOnServer: address in serverInternals()._startedCommunities,
                persisted: persistedStartState(address)
            }).toEqual({ runningOnServer: false, persisted: { wasStarted: 1, wasExplicitlyStopped: 1 } });
        });

        it("a community stopped by someone else while this client was disconnected stays stopped, and the client is told", async () => {
            const { client, community, address, publicKey } = await startCommunityOverRpc();
            const { reconnect } = await dropConnection(client, "backlog");
            await serverInternals().stopCommunity([{ publicKey }]);
            expect(community.startedState).not.toBe("stopped");

            await reconnect();
            await pollUntil(() => community.startedState === "stopped", { timeoutMs: DELIVERY_WINDOW_MS });
            expect({
                clientStartedState: community.startedState,
                runningOnServer: address in serverInternals()._startedCommunities,
                persisted: persistedStartState(address)
            }).toEqual({
                clientStartedState: "stopped",
                runningOnServer: false,
                persisted: { wasStarted: 1, wasExplicitlyStopped: 1 }
            });
        });

        it("a community the server lost without a stop (a server restart) is started again by the reconnect", async () => {
            const { client, community, address } = await startCommunityOverRpc();
            const { reconnect } = await dropConnection(client, "backlog");
            // What a server restart looks like from here: the running instance is gone, the
            // persisted record still says started and not explicitly stopped
            const serverSideStarted = await serverInternals().getStartedCommunity(address);
            await serverSideStarted.stop();
            delete serverInternals()._startedCommunities[address];

            await reconnect();
            await pollUntil(() => address in serverInternals()._startedCommunities, { timeoutMs: DELIVERY_WINDOW_MS });
            const restarted = await serverInternals().getStartedCommunity(address);
            const titleAfterRestart = `after restart ${Date.now()}`;
            await editAndAwaitPublish(restarted, { title: titleAfterRestart });
            await pollUntil(() => community.title === titleAfterRestart, { timeoutMs: DELIVERY_WINDOW_MS });
            expect(community.title).toBe(titleAfterRestart);
            await community.stop();
        });
    });

    describe("the connection itself", () => {
        // The earlier cases leave their clients connected (afterAll destroys them), and those would
        // reconnect through every outage here and show up in the server's connection counts
        beforeEach(async () => {
            for (const client of clients) if (!client.destroyed) await client.destroy();
        });

        // Stop the server accepting connections: terminate the open sockets and close the listener,
        // so every reconnect attempt fails with ECONNREFUSED. restore() listens on the same port again
        async function takeServerDown(): Promise<{ restore: () => Promise<void> }> {
            const httpServer = serverInternals()._httpServer;
            const address = httpServer.address();
            if (!address || typeof address !== "object") throw new Error("Test setup failed: the RPC server has no bound port");
            const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
            for (const socket of serverInternals().rpcWebsockets.wss.clients) socket.terminate();
            await closed;
            await Promise.all([...serverInternals()._pendingDisconnectionCleanups]);
            return {
                restore: () =>
                    new Promise<void>((resolve, reject) => {
                        httpServer.once("error", reject);
                        httpServer.listen(address.port, () => {
                            httpServer.removeListener("error", reject);
                            resolve();
                        });
                    })
            };
        }

        // Fast backoff so a test can watch many failed attempts in a few seconds
        function useFastBackoff(client: PKCType) {
            const rpcClient = rpcClientOf(client);
            rpcClient._reconnectBaseIntervalMs = 50;
            rpcClient._reconnectMaxIntervalMs = 200;
        }

        it("keeps reconnecting past rpc-websockets' default 5 attempts, then delivers updates again", async () => {
            const client = await createClient();
            useFastBackoff(client);
            const community = await client.createCommunity({ address: updatingCommunity.address });
            await community.update();
            await pollUntil(() => typeof community.updatedAt === "number", { timeoutMs: 30_000 });
            const rpcClient = rpcClientOf(client);

            const { restore } = await takeServerDown();
            let restored = false;
            try {
                await pollUntil(() => rpcClient._webSocketClient.getCurrentReconnects() > 8, { timeoutMs: 15_000 });
                expect(rpcClient._webSocketClient.getCurrentReconnects()).toBeGreaterThan(8);
                await restore();
                restored = true;
                await pollUntil(() => rpcClient.state === "connected", { timeoutMs: 15_000 });
                expect(rpcClient.state).toBe("connected");

                const titleAfterOutage = `after outage ${Date.now()}`;
                await editAndAwaitPublish(updatingCommunity, { title: titleAfterOutage });
                await pollUntil(() => community.title === titleAfterOutage, { timeoutMs: DELIVERY_WINDOW_MS });
                expect(community.title).toBe(titleAfterOutage);
            } finally {
                if (!restored) await restore();
                await community.stop();
            }
        });

        it("pkc.destroy() during the reconnect backoff leaves no connection and no pending reconnect", async () => {
            const client = await createClient();
            useFastBackoff(client);
            const community = await client.createCommunity({ address: updatingCommunity.address });
            await community.update();
            await pollUntil(() => typeof community.updatedAt === "number", { timeoutMs: 30_000 });
            const rpcClient = rpcClientOf(client);

            const { restore } = await takeServerDown();
            await pollUntil(() => rpcClient._webSocketClient.getCurrentReconnects() > 2, { timeoutMs: 15_000 });
            await client.destroy();

            let connectionsAfterDestroy = 0;
            serverInternals().rpcWebsockets.wss.on("connection", () => connectionsAfterDestroy++);
            await restore();
            // Several max backoff intervals: a reconnect timer left behind by destroy() would fire in here
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            expect({
                connectionsAfterDestroy,
                openServerConnections: serverInternals().rpcWebsockets.wss.clients.size,
                rpcClientState: rpcClient.state
            }).toEqual({ connectionsAfterDestroy: 0, openServerConnections: 0, rpcClientState: "stopped" });
        });

        it("pkc.destroy() while connected closes the connection and nothing reconnects", async () => {
            const client = await createClient();
            useFastBackoff(client);
            const community = await client.createCommunity({ address: updatingCommunity.address });
            await community.update();
            await pollUntil(() => typeof community.updatedAt === "number", { timeoutMs: 30_000 });
            const rpcClient = rpcClientOf(client);
            expect(serverInternals().rpcWebsockets.wss.clients.size).toBe(1);

            let connectionsAfterDestroy = 0;
            serverInternals().rpcWebsockets.wss.on("connection", () => connectionsAfterDestroy++);
            await client.destroy();
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            expect({
                connectionsAfterDestroy,
                openServerConnections: serverInternals().rpcWebsockets.wss.clients.size,
                rpcClientState: rpcClient.state
            }).toEqual({ connectionsAfterDestroy: 0, openServerConnections: 0, rpcClientState: "stopped" });
        });
    });
});

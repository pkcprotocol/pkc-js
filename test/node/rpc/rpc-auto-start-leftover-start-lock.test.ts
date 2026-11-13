import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { temporaryDirectory } from "tempy";
import PKCWsServer from "../../../dist/node/rpc/src/index.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { isCommunityStartLocked } from "../../../dist/node/runtime/node/community/start-lock.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// A server process that is killed leaves the start locks of its communities behind, and a lock only goes stale 10s
// after its holder last refreshed it. A server restarted sooner than that (a process supervisor with a short restart
// delay) found the lock held at auto-start, failed the start with ERR_COMMUNITY_ALREADY_STARTED, and never tried
// again, so the community stayed unhosted until someone started it by hand.
//
// The leftover lock is made the way it happens in production: another OS process takes the lock with the lock library
// and is SIGKILLed. No Kubo node is needed: the test replaces _internalStartCommunity with the part of
// community.start() that decides this bug, which is the "is it started" check followed by lockCommunityStart(), both
// real and both on the real lock.

type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

interface PKCWsServerPrivateAccess {
    _startedCommunities: Record<string, unknown>;
    _autoStartOnBoot: boolean;
    _autoStartPreviousCommunities: () => Promise<void>;
    _internalStartCommunity: (address: string) => Promise<LocalCommunity>;
    _updateCommunityState: (address: string, update: { wasStarted: boolean; wasExplicitlyStopped: boolean }) => void;
    pkc: PKCType;
}

// Takes the start lock the way db-handler's lockCommunityStart does, then keeps running (and refreshing the lock)
// until it is killed
const lockHolderScript = `
import lockfile from "@pkcprotocol/proper-lock-file";
const [communityDbPath, lockfilePath] = process.argv.slice(1);
await lockfile.lock(communityDbPath, { lockfilePath });
process.stdout.write("locked");
setInterval(() => {}, 1000);
`;

// describeSkipIfRpc: drives the private auto-start of an RPC server created in this process and takes file locks in
// its dataPath, which a remote RPC server does not expose.
describeSkipIfRpc("RPC auto-start with a start lock that is already held", () => {
    let rpcServer: PKCWsServerType | undefined;
    let lockHolder: ChildProcess | undefined;
    let startedCommunity: LocalCommunity | undefined;

    const killLockHolder = async () => {
        if (!lockHolder || lockHolder.exitCode !== null || lockHolder.signalCode !== null) return;
        const exited = once(lockHolder, "exit");
        lockHolder.kill("SIGKILL");
        await exited;
    };

    afterEach(async () => {
        vi.restoreAllMocks();
        await killLockHolder();
        lockHolder = undefined;
        await startedCommunity?._dbHandler.unlockCommunityStart();
        startedCommunity = undefined;
        await rpcServer?.destroy();
        rpcServer = undefined;
    });

    // An RPC server with one community that its state db records as started and not explicitly stopped, whose start
    // lock is held by another process
    const setUpServerWithLockedCommunity = async (rpcServerPort: number) => {
        const dataPath = temporaryDirectory();
        rpcServer = await PKCWsServer.PKCWsServer({
            port: rpcServerPort,
            // Nothing listens on this port: the test never reaches the Kubo node
            pkcOptions: { kuboRpcClientsOptions: ["http://127.0.0.1:1/api/v0"], httpRoutersOptions: [], dataPath },
            startStartedCommunitiesOnStartup: false
        });
        const priv = rpcServer as unknown as PKCWsServerPrivateAccess;
        const errors: Error[] = [];
        rpcServer.on("error", (error) => errors.push(error));

        const address = ((await priv.pkc.createCommunity({})) as LocalCommunity).address;
        priv._updateCommunityState(address, { wasStarted: true, wasExplicitlyStopped: false });

        const communityDbPath = path.join(dataPath, "communities", address);
        lockHolder = spawn(
            process.execPath,
            ["--input-type=module", "-e", lockHolderScript, communityDbPath, `${communityDbPath}.start.lock`],
            { stdio: ["ignore", "pipe", "inherit"] }
        );
        await once(lockHolder.stdout!, "data");
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.true;

        let startAttempts = 0;
        vi.spyOn(priv, "_internalStartCommunity").mockImplementation(async (addressToStart: string) => {
            startAttempts++;
            const community = (await priv.pkc.createCommunity({ address: addressToStart })) as LocalCommunity;
            await community.initDbHandlerIfNeeded();
            await community._updateStartedValue();
            if (community.started) throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: addressToStart });
            await community._dbHandler.lockCommunityStart();
            startedCommunity = community;
            priv._startedCommunities[addressToStart] = community;
            return community;
        });

        priv._autoStartOnBoot = true;
        return { priv, address, dataPath, errors, getStartAttempts: () => startAttempts };
    };

    it("starts the community once the lock left by a killed process goes stale", async () => {
        const { priv, address, dataPath, errors } = await setUpServerWithLockedCommunity(19176);

        // The holder dies without releasing its lock, and the server "restarts" right away
        await killLockHolder();
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address }), "the leftover lock should still be fresh").to.be.true;

        await priv._autoStartPreviousCommunities();

        expect(errors, "auto-start should not have given up on the leftover lock").to.deep.equal([]);
        expect(priv._startedCommunities[address], "the community was left unhosted").to.equal(startedCommunity);
        expect(startedCommunity).to.not.be.undefined;
    }, 60_000);

    it("still fails with ERR_COMMUNITY_ALREADY_STARTED when a live process holds the lock, and leaves that lock alone", async () => {
        const { priv, address, dataPath, errors, getStartAttempts } = await setUpServerWithLockedCommunity(19177);

        await priv._autoStartPreviousCommunities();

        expect(getStartAttempts()).to.equal(1);
        expect(errors.map((error) => (error as PKCError).code)).to.deep.equal(["ERR_COMMUNITY_ALREADY_STARTED"]);
        expect(address in priv._startedCommunities).to.be.false;
        expect(lockHolder?.exitCode, "the process holding the lock should still be running").to.be.null;
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address }), "the live holder lost its lock").to.be.true;
    }, 60_000);
});

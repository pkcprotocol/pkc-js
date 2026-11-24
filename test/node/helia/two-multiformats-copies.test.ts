import { afterEach, expect, it, vi } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import { unixfs } from "@helia/unixfs";
import { CID } from "multiformats/cid";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { MockHttpRouter } from "../../../dist/node/runtime/node/test/mock-http-router.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";

// PR #580: a consumer's install can hold two copies of multiformats 14, ours (pinned exactly) and the
// one the helia tree resolves from its `^14` range. Yarn 4, pnpm and Bun produce that as soon as a
// 14.x newer than our pin is published. ipfs-unixfs-exporter accepts a CID object only from its own
// copy (`CID.asCID(path) === path || path instanceof CID`, see ipfs/js-ipfs-unixfs#506), so when
// cat() and resolve() handed it our CID object every libp2p-js fetch failed with
// "Path must be string or CID" before a single block was requested.
//
// This repo's lockfile holds one multiformats 14 copy, so the split is built here: every multiformats
// entry point pkc-js imports is swapped for `multiformats-second-copy` (an npm alias of another 14.x
// release). vitest applies the swap to the modules it transforms (`dist/` and this file) and leaves
// `node_modules` alone, so @helia/unixfs and the exporter keep the real copy. That is the same shape
// as the consumer install: pkc-js on one copy, the helia tree on the other.
//
// The content lives only on the test server's kubo node, so the fetch goes through the bitswap
// session that is seeded with our copy's root CID, not just through the exporter's argument check.
vi.mock("multiformats/cid", async () => await import("multiformats-second-copy/cid"));
vi.mock("multiformats/basics", async () => await import("multiformats-second-copy/basics"));
vi.mock("multiformats/bases/base32", async () => await import("multiformats-second-copy/bases/base32"));
vi.mock("multiformats/bases/base58", async () => await import("multiformats-second-copy/bases/base58"));
vi.mock("multiformats/codecs/raw", async () => await import("multiformats-second-copy/codecs/raw"));
vi.mock("multiformats/hashes/digest", async () => await import("multiformats-second-copy/hashes/digest"));
vi.mock("multiformats/hashes/sha2", async () => await import("multiformats-second-copy/hashes/sha2"));

const KUBO_API_URL = "http://localhost:15001/api/v0";
const FILE_NAME = "update";

// Client-side libp2p only and config-independent: under RPC the fetch runs on the server, so there is nothing to test here.
// Node only (it lives under test/node): in the browser runs vite bundles the dependencies too, so the
// swap would reach the exporter as well and there would be no split. The exporter's check is plain JS
// and behaves the same in both runtimes.
describeSkipIfRpc("libp2p-js fetches work when the install has two multiformats copies (PR #580)", () => {
    const routers: MockHttpRouter[] = [];
    const clients: Libp2pJsClient[] = [];

    afterEach(async () => {
        while (clients.length) await clients.pop()!.heliaWithKuboRpcClientFunctions.stop();
        while (routers.length) await routers.pop()!.destroy();
    });

    const addDirectoryWithOneFileToKubo = async (content: string) => {
        const form = new FormData();
        form.append("file", new Blob([content]), FILE_NAME);
        const addRes = await fetch(`${KUBO_API_URL}/add?pin=false&wrap-with-directory=true`, { method: "POST", body: form });
        expect(addRes.ok, "kubo add should succeed").to.be.true;
        const entries = (await addRes.text())
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as { Name: string; Hash: string });
        const fileCid = entries.find((entry) => entry.Name === FILE_NAME)?.Hash;
        const dirCid = entries.find((entry) => entry.Name === "")?.Hash;
        expect(fileCid, "kubo add should return the file CID").to.be.a("string");
        expect(dirCid, "kubo add should return the wrapping directory CID").to.be.a("string");
        return { fileCid: fileCid!, dirCid: dirCid! };
    };

    const createClientConnectedToKubo = async () => {
        const idRes = await fetch(`${KUBO_API_URL}/id`, { method: "POST" });
        const kuboAddresses = ((await idRes.json()) as { Addresses: string[] }).Addresses;
        const kuboWsAddress = kuboAddresses.find((address) => address.startsWith("/ip4/127.0.0.1/") && address.includes("/ws/"));
        expect(kuboWsAddress, "the test kubo node should listen on a loopback WebSocket address").to.be.a("string");

        const router = new MockHttpRouter();
        await router.start();
        routers.push(router);
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `two-multiformats-copies-${Math.random()}`,
            httpRoutersOptions: [router.url],
            libp2pOptions: { connectionGater: { denyDialMultiaddr: async () => false } },
            heliaOptions: {}
        })) as Libp2pJsClient;
        clients.push(client);
        await client._helia.libp2p.dial(multiaddr(kuboWsAddress!));
        return client;
    };

    const catToString = async (client: Libp2pJsClient, ipfsPath: string) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of client.heliaWithKuboRpcClientFunctions.cat(ipfsPath, { timeout: "30s" })) chunks.push(chunk);
        return Buffer.concat(chunks).toString();
    };

    it("this process really holds two copies, and the exporter rejects a CID object from the other one", async () => {
        const { CID: exporterCopyCid } = await vi.importActual<typeof import("multiformats/cid")>("multiformats/cid");
        expect(CID, "pkc-js's CID class must come from the second copy").to.not.equal(exporterCopyCid);

        const content = `two-multiformats-copies-exporter-${Date.now()}-${Math.random()}`;
        const { fileCid } = await addDirectoryWithOneFileToKubo(content);
        const client = await createClientConnectedToKubo();
        const fs = unixfs(client._helia);
        const read = async (root: Parameters<typeof fs.cat>[0]) => {
            const chunks: Uint8Array[] = [];
            for await (const chunk of fs.cat(root, { signal: AbortSignal.timeout(30_000) })) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
        };

        expect(await read(exporterCopyCid.parse(fileCid)), "a CID object from the exporter's own copy is accepted").to.equal(content);

        // If this starts passing, ipfs/js-ipfs-unixfs#506 is fixed and the string root in
        // helia-for-pkc.ts (asUnixfsRoot) is no longer load-bearing.
        let rejection: Error | undefined;
        try {
            await read(CID.parse(fileCid));
        } catch (error) {
            rejection = error as Error;
        }
        expect(rejection?.message, "a CID object from the other copy is rejected by the exporter").to.equal("Path must be string or CID");
    }, 60_000);

    it("cat() fetches a bare CID and a <dirCid>/<file> sub-path from a peer", async () => {
        const content = `two-multiformats-copies-cat-${Date.now()}-${Math.random()}`;
        const { fileCid, dirCid } = await addDirectoryWithOneFileToKubo(content);
        const client = await createClientConnectedToKubo();

        expect(await catToString(client, `${dirCid}/${FILE_NAME}`), "sub-path fetch").to.equal(content);
        expect(await catToString(client, fileCid), "bare CID fetch").to.equal(content);
    }, 60_000);

    it("resolve() stats a bare CID and a <dirCid>/<file> sub-path from a peer", async () => {
        const content = `two-multiformats-copies-resolve-${Date.now()}-${Math.random()}`;
        const { fileCid, dirCid } = await addDirectoryWithOneFileToKubo(content);
        const client = await createClientConnectedToKubo();
        const { resolve } = client.heliaWithKuboRpcClientFunctions;

        expect(await resolve(`${dirCid}/${FILE_NAME}`, { timeout: "30s" }), "sub-path resolve").to.equal(`/ipfs/${fileCid}`);
        expect(await resolve(dirCid, { timeout: "30s" }), "bare CID resolve").to.equal(`/ipfs/${dirCid}`);
    }, 60_000);
});

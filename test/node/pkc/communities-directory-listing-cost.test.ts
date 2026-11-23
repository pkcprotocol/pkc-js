import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "path";
import fs from "fs";

// Every listing of a `communities` directory is recorded, with the path it listed
const { directoryListings } = vi.hoisted(() => ({ directoryListings: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    const recordListing = (directory: unknown) => {
        if (path.basename(String(directory)) === "communities") directoryListings.push(path.resolve(String(directory)));
    };
    const readdirSync = (...args: unknown[]) => {
        recordListing(args[0]);
        return Reflect.apply(original.readdirSync, original, args);
    };
    const opendirSync = (...args: unknown[]) => {
        recordListing(args[0]);
        return Reflect.apply(original.opendirSync, original, args);
    };
    const promises = {
        ...original.promises,
        readdir: (...args: unknown[]) => {
            recordListing(args[0]);
            return Reflect.apply(original.promises.readdir, original.promises, args);
        }
    };
    return { ...original, default: { ...original, readdirSync, opendirSync, promises }, readdirSync, opendirSync, promises };
});

import { mockPKC } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// One listing of dataPath/communities reads every entry in it, and a started community has several. A node that lists
// the directory for each community it loads, creates or starts therefore pays for all of them every time: restarting
// 10,000 communities spent 494 of 880 seconds listing the directory, twice per createCommunity({ address }) (issues
// #576 and #585). The directory may be listed when a PKC is created, and never per community after that.
//
// Skipped under RPC: an RPC client has no communities directory. The listing happens in the RPC server's process,
// where this test's mock of node:fs does not reach.
describeSkipIfRpc("pkc.communities: the communities directory is not listed per community", () => {
    let pkc: PKC;
    const existingAddresses: string[] = [];
    const listingsOfThisPkc = () => {
        const communitiesPath = path.resolve(pkc.dataPath!, "communities");
        return directoryListings.filter((listed) => listed === communitiesPath);
    };

    beforeAll(async () => {
        // A dataPath of its own: the default one is shared with the test server and every other test file, whose
        // communities and filesystem events are not this test's
        pkc = await mockPKC({
            dataPath: path.join(process.cwd(), ".tmp", `communities-directory-listing-cost-${Date.now()}-${process.pid}`)
        });
        for (let i = 0; i < 5; i++) existingAddresses.push((await pkc.createCommunity()).address);
    });

    afterAll(async () => {
        const dataPath = pkc.dataPath!;
        await pkc.destroy();
        await fs.promises.rm(dataPath, { recursive: true, force: true });
    });

    it("createCommunity({ address }) of an existing local community lists nothing", async () => {
        directoryListings.length = 0;
        for (const address of existingAddresses) {
            const community = (await pkc.createCommunity({ address })) as LocalCommunity;
            expect(community.address).to.equal(address);
            expect(community.signer?.address, "it should have loaded as a local community").to.be.a("string");
        }
        expect(listingsOfThisPkc()).to.deep.equal([]);
    });

    it("createCommunity({ publicKey }) of an existing local community lists nothing", async () => {
        directoryListings.length = 0;
        const community = (await pkc.createCommunity({ publicKey: existingAddresses[0] })) as LocalCommunity;
        expect(community.signer?.address, "it should have loaded as a local community").to.be.a("string");
        expect(listingsOfThisPkc()).to.deep.equal([]);
    });

    it("createCommunity({ address }) of a community that is not local lists nothing", async () => {
        directoryListings.length = 0;
        const remote = await pkc.createCommunity({ address: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR" });
        expect((remote as LocalCommunity).signer).to.be.undefined;
        expect(listingsOfThisPkc()).to.deep.equal([]);
    });

    it("creating a new community lists nothing, and the community is in pkc.communities when createCommunity resolves", async () => {
        directoryListings.length = 0;
        const community = await pkc.createCommunity();
        expect(pkc.communities.map((entry) => entry.address)).to.include(community.address);
        // a filesystem event of the new files may arrive after createCommunity has resolved
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(listingsOfThisPkc()).to.deep.equal([]);
    });

    it("starting and stopping a community lists nothing, and `started` follows in pkc.communities", async () => {
        const community = (await pkc.createCommunity({ address: existingAddresses[1] })) as LocalCommunity;
        const listedStarted = () => pkc.communities.find((entry) => entry.address === community.address)?.started;
        directoryListings.length = 0;
        await community.start();
        expect(listedStarted()).to.equal(true);
        await community.stop();
        expect(listedStarted()).to.equal(false);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(listingsOfThisPkc()).to.deep.equal([]);
    });
});

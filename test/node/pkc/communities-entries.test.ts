import { describe, it, expect } from "vitest";
import {
    createMockNameResolver,
    mockPKCV2,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { v4 as uuidV4 } from "uuid";

import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCCommunitiesEntry } from "../../../dist/node/clients/rpc-client/types.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

// pkc.communities lists { name?, publicKey, started } per local community (issue #455, folding in #141), so a caller
// that knows a community only by its key can find it, and a thin RPC client reads `started` without loading anything

const findEntry = (pkc: PKC, publicKey: string): PKCCommunitiesEntry | undefined =>
    pkc.communities.find((entry) => entry.publicKey === publicKey);

const waitForEntry = (pkc: PKC, publicKey: string, predicate: (entry: PKCCommunitiesEntry) => boolean) =>
    resolveWhenConditionIsTrue({
        toUpdate: pkc,
        predicate: async () => {
            const entry = findEntry(pkc, publicKey);
            return Boolean(entry && predicate(entry));
        },
        eventName: "communitieschange"
    });

describe(`pkc.communities entries`, async () => {
    it(`a community without a name is listed as { publicKey, started: false }`, async () => {
        const pkc = await mockPKCV2();
        const community = await createSubWithNoChallenge({}, pkc);
        try {
            await waitForEntry(pkc, community.signer!.address, () => true);
            expect(findEntry(pkc, community.signer!.address)).to.deep.equal({ publicKey: community.signer!.address, started: false });
        } finally {
            await community.delete().catch((): undefined => undefined);
            await pkc.destroy();
        }
    });

    it(`communitieschange passes { communities } with the same entries as pkc.communities`, async () => {
        const pkc = await mockPKCV2();
        const events: { communities: PKCCommunitiesEntry[] }[] = [];
        pkc.on("communitieschange", (event) => events.push(event));
        const community = await createSubWithNoChallenge({}, pkc);
        try {
            await waitForEntry(pkc, community.signer!.address, () => true);
            const lastEvent = events[events.length - 1];
            expect(lastEvent).to.have.keys(["communities"]);
            expect(lastEvent.communities).to.deep.equal(pkc.communities);
        } finally {
            await community.delete().catch((): undefined => undefined);
            await pkc.destroy();
        }
    });

    it(`started follows start() and stop(), and matches community.started`, async () => {
        const pkc = await mockPKCV2();
        const community = await createSubWithNoChallenge({}, pkc);
        const publicKey = community.signer!.address;
        try {
            await community.start();
            await waitForEntry(pkc, publicKey, (entry) => entry.started);
            expect(community.started).to.be.true;

            await community.stop();
            await waitForEntry(pkc, publicKey, (entry) => !entry.started);
            expect(community.started).to.be.false;
        } finally {
            await community.delete().catch((): undefined => undefined);
            await pkc.destroy();
        }
    });
});

// Skipped under RPC because these use a name resolver with records added by the test, which only exists in this process,
// and read the list of a second PKC instance on the same dataPath, which an RPC client does not have
describeSkipIfRpc(`pkc.communities entries of local communities (Node)`, async () => {
    const createPKCWithRecords = async () => {
        const records = new Map<string, string | undefined>();
        const pkc = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            pkcOptions: { nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records })] }
        });
        return { pkc, records };
    };

    for (const started of [false, true]) {
        it(`a ${started ? "started" : "stopped"} community renamed with edit({ name }) is listed with its name and the same key at once`, async () => {
            const { pkc, records } = await createPKCWithRecords();
            const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
            const publicKey = community.signer.address;
            const name = `entries-${started ? "started" : "stopped"}-${uuidV4()}.bso`;
            records.set(name, publicKey);
            try {
                if (started) await community.start();
                await community.edit({ name });
                // No wait: edit() lists the new identity itself, while the DB still holds the old one
                expect(findEntry(pkc, publicKey)).to.deep.equal({ name, publicKey, started });
                expect(pkc.communities.filter((entry) => entry.publicKey === publicKey)).to.have.length(1);

                // Asked for by key, the community listed under its name is the local one, at its name
                const byKey = (await pkc.createCommunity({ publicKey })) as LocalCommunity | RpcLocalCommunity;
                expect(byKey.constructor.name).to.equal("LocalCommunity");
                expect(byKey.address).to.equal(name);
            } finally {
                await community.delete().catch((): undefined => undefined);
                await pkc.destroy();
            }
        });
    }

    it(`a name reused by another community after delete() is listed with the new community's key`, async () => {
        const { pkc, records } = await createPKCWithRecords();
        const name = `entries-reused-${uuidV4()}.bso`;
        const first = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const second = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        try {
            records.set(name, first.signer.address);
            await first.edit({ name });
            expect(findEntry(pkc, first.signer.address)?.name).to.equal(name);

            await first.delete();
            expect(findEntry(pkc, first.signer.address)).to.be.undefined;

            records.set(name, second.signer.address);
            await second.edit({ name });
            expect(pkc.communities.filter((entry) => entry.name === name)).to.deep.equal([
                { name, publicKey: second.signer.address, started: false }
            ]);
        } finally {
            await second.delete().catch((): undefined => undefined);
            await pkc.destroy();
        }
    });

    it(`started is the start lock, so another PKC instance on the same dataPath sees it too`, async () => {
        const starterPKC = await mockPKCV2();
        const observerPKC = await mockPKCV2({ pkcOptions: { dataPath: starterPKC.dataPath } });
        const community = (await createSubWithNoChallenge({}, starterPKC)) as LocalCommunity;
        const publicKey = community.signer.address;
        try {
            await waitForEntry(observerPKC, publicKey, (entry) => !entry.started);

            await community.start();
            await waitForEntry(observerPKC, publicKey, (entry) => entry.started);

            await community.stop();
            await waitForEntry(observerPKC, publicKey, (entry) => !entry.started);
        } finally {
            await community.delete().catch((): undefined => undefined);
            await observerPKC.destroy();
            await starterPKC.destroy();
        }
    });
});

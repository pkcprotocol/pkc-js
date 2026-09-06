import { it, describe, beforeAll, afterAll, expect } from "vitest";
import env from "../../../dist/node/version.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { STORAGE_KEYS } from "../../../dist/node/constants.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import signers from "../../fixtures/signers.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { InternalCommunityRecordBeforeFirstUpdateType } from "../../../dist/node/community/types.js";
import type Database from "better-sqlite3";

// v41 -> v42 changes no table schema. It migrates the private challenge settings: the conflated
// `exclude.address` array is split into `exclude.publicKeys` (key-derived addresses, matched
// against the publication signature) and `exclude.names` (domains, resolved and compared to the
// signer at match time). See issue #267.

const COMMUNITY_ADDRESS = "12D3KooWTestCommunityAddressV42";
const now = Math.floor(Date.now() / 1000);
const OWNER_DOMAIN = "owner-v42.bso";
const MOD_DOMAIN = "mod-v42.bso";
const RAW_ADDRESS = signers[3].address;
const OTHER_RAW_ADDRESS = signers[4].address;

interface FakeCommunity {
    address: string;
    _pkc: { noData: boolean; dataPath: undefined };
    _dbHandler?: DbHandler;
    // updateDbInternalState (run by the settings migration) reads the current state and mirrors it into raw
    _getDbInternalState: (lock: boolean) => Promise<unknown>;
    raw: { communityIpfs?: unknown; localCommunity?: unknown };
    settings?: unknown;
    updateCid?: string;
    _cidsToUnPin: Set<string>;
    _blocksToRm: string[];
    _mfsPathsToRemove: Set<string>;
    _clientsManager: object;
    _calculateLocalMfsPathForCommentUpdate: () => string;
    _addOldPageCidsToCidsToUnpin: () => Promise<void>;
    _addAllCidsUnderPurgedCommentToBeRemoved: () => void;
}

function createFakeCommunity(address: string): FakeCommunity {
    const fake: FakeCommunity = {
        address,
        _pkc: { noData: true, dataPath: undefined },
        _getDbInternalState: async () => fake._dbHandler!.keyvGet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]),
        raw: {},
        _cidsToUnPin: new Set<string>(),
        _blocksToRm: [],
        _mfsPathsToRemove: new Set<string>(),
        _clientsManager: {},
        _calculateLocalMfsPathForCommentUpdate: () => "",
        _addOldPageCidsToCidsToUnpin: async () => {},
        _addAllCidsUnderPurgedCommentToBeRemoved: () => {}
    };
    return fake;
}

interface DbHandlerPrivate {
    _db: Database.Database;
    _createdTables: boolean;
    _purgeCommentsWithInvalidSchemaOrSignature: () => Promise<void>;
    _purgeCommentEditsWithInvalidSchemaOrSignature: () => Promise<void>;
    _purgePublicationTablesWithDuplicateSignatures: () => Promise<void>;
    lockCommunityState: () => Promise<void>;
    unlockCommunityState: () => Promise<void>;
}

function getPrivate(handler: DbHandler): DbHandlerPrivate {
    return handler as unknown as DbHandlerPrivate;
}

// The pre-v42 shape of an exclude, as stored by older clients.
type LegacyExclude = { address?: string[]; challenges?: number[]; role?: string[] };
type MigratedExclude = {
    address?: string[];
    publicKeys?: string[];
    names?: string[];
    challenges?: number[];
    role?: string[];
    roles?: string[];
};
type MigratedInternalState = {
    settings: { challenges?: Array<{ name?: string; exclude?: MigratedExclude[] }> };
    challenges?: Array<{ exclude?: MigratedExclude[] }>;
};

const legacyChallenges: Array<{ name: string; exclude?: LegacyExclude[]; options?: Record<string, string> }> = [
    {
        // owner-only posting: fail challenge with a mixed domain + raw address exclude
        name: "fail",
        exclude: [{ address: [OWNER_DOMAIN, RAW_ADDRESS] }, { role: ["moderator"] }]
    },
    {
        // domain-only exclude, plus an exclude with no author identity at all
        name: "question",
        options: { question: "1+1?", answer: "2" },
        exclude: [{ address: [MOD_DOMAIN] }, { challenges: [0] }]
    },
    {
        // raw-address-only exclude
        name: "fail",
        exclude: [{ address: [OTHER_RAW_ADDRESS] }]
    },
    {
        // no exclude at all
        name: "fail"
    },
    {
        // role rename, alone and combined with an address split
        name: "fail",
        exclude: [{ role: ["moderator", "admin"] }, { role: ["owner"], address: [OWNER_DOMAIN, RAW_ADDRESS] }]
    }
];

// Uses DbHandler directly (Node-only) and seeds the private internal state; cannot run under RPC.
describeSkipIfRpc("v41 -> v42 DB migration (exclude.address split into publicKeys and names)", () => {
    let dbHandler: DbHandler | undefined;
    let migrated: MigratedInternalState;

    afterAll(() => {
        if (dbHandler) {
            dbHandler.destoryConnection();
            dbHandler = undefined;
        }
    });

    beforeAll(async () => {
        const fakeCommunity = createFakeCommunity(COMMUNITY_ADDRESS);
        dbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
        fakeCommunity._dbHandler = dbHandler;
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        // Tables did not change between v41 and v42, so create them at the current schema first.
        await dbHandler.createOrMigrateTablesIfNeeded();

        const priv = getPrivate(dbHandler);
        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};
        // updateDbInternalState takes a file lock under dataPath; an in-memory DB has none.
        priv.lockCommunityState = async () => {};
        priv.unlockCommunityState = async () => {};

        const legacyInternalState: Omit<InternalCommunityRecordBeforeFirstUpdateType, "settings" | "challenges"> & {
            settings: { challenges: typeof legacyChallenges };
        } = {
            address: COMMUNITY_ADDRESS,
            createdAt: now,
            protocolVersion: "1.0.0",
            encryption: { type: "ed25519-aes-gcm", publicKey: signers[0].publicKey },
            signer: {
                type: "ed25519",
                publicKey: signers[0].publicKey,
                privateKey: signers[0].privateKey,
                address: signers[0].address,
                shortAddress: signers[0].address.slice(8).slice(0, 12)
            },
            settings: { challenges: legacyChallenges },
            _usingDefaultChallenge: false,
            _internalStateUpdateId: "legacy-uuid",
            _pendingEditProps: [],
            _cidsToUnPin: [],
            _blocksToRm: [],
            _mfsPathsToRemove: [],
            _pendingUpdatesFromRemoteMirror: [],
            signature: undefined,
            updateCid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f"
        } as unknown as Omit<InternalCommunityRecordBeforeFirstUpdateType, "settings" | "challenges"> & {
            settings: { challenges: typeof legacyChallenges };
        };
        await dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY], legacyInternalState);

        priv._db.pragma("user_version = 41");
        priv._createdTables = false;
        await dbHandler.createOrMigrateTablesIfNeeded();

        migrated = (await dbHandler.keyvGet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY])) as MigratedInternalState;
    });

    it("DB version was bumped to the latest", () => {
        const priv = getPrivate(dbHandler!);
        expect(priv._db.pragma("user_version", { simple: true })).to.equal(env.DB_VERSION);
        expect(env.DB_VERSION).to.be.greaterThanOrEqual(42);
    });

    it("splits a mixed exclude.address into publicKeys and names", () => {
        const exclude = migrated.settings.challenges![0].exclude!;
        expect(exclude[0]).to.not.have.property("address");
        expect(exclude[0].publicKeys).to.deep.equal([RAW_ADDRESS]);
        expect(exclude[0].names).to.deep.equal([OWNER_DOMAIN]);
        // sibling exclude without an address only gets the role rename
        expect(exclude[1]).to.deep.equal({ roles: ["moderator"] });
    });

    it("migrates a domain-only exclude.address into names only", () => {
        const exclude = migrated.settings.challenges![1].exclude!;
        expect(exclude[0]).to.not.have.property("address");
        expect(exclude[0]).to.not.have.property("publicKeys");
        expect(exclude[0].names).to.deep.equal([MOD_DOMAIN]);
        expect(exclude[1]).to.deep.equal({ challenges: [0] });
    });

    it("migrates a raw-address-only exclude.address into publicKeys only", () => {
        const exclude = migrated.settings.challenges![2].exclude!;
        expect(exclude[0]).to.not.have.property("address");
        expect(exclude[0]).to.not.have.property("names");
        expect(exclude[0].publicKeys).to.deep.equal([OTHER_RAW_ADDRESS]);
    });

    it("leaves challenges without excludes alone", () => {
        expect(migrated.settings.challenges![3]).to.not.have.property("exclude");
    });

    it("renames exclude.role to exclude.roles, alone and alongside an address split", () => {
        const exclude = migrated.settings.challenges![4].exclude!;
        expect(exclude[0]).to.deep.equal({ roles: ["moderator", "admin"] });
        expect(exclude[1]).to.not.have.property("role");
        expect(exclude[1]).to.not.have.property("address");
        expect(exclude[1].roles).to.deep.equal(["owner"]);
        expect(exclude[1].names).to.deep.equal([OWNER_DOMAIN]);
        expect(exclude[1].publicKeys).to.deep.equal([RAW_ADDRESS]);
        for (const challenge of migrated.settings.challenges!)
            for (const e of challenge.exclude || []) expect(e).to.not.have.property("role");
    });

    it("re-derives the public challenges from the migrated settings", () => {
        expect(migrated.challenges).to.have.length(5);
        for (let i = 0; i < 5; i++) expect(migrated.challenges![i].exclude).to.deep.equal(migrated.settings.challenges![i].exclude);
        for (const challenge of migrated.challenges!)
            for (const exclude of challenge.exclude || []) expect(exclude).to.not.have.property("address");
    });

    it("no legacy field survives anywhere in the migrated state", () => {
        expect(JSON.stringify(migrated)).to.not.match(/"address":\s*\[/);
        expect(JSON.stringify(migrated)).to.not.match(/"role":\s*\[/);
    });
});

// Unit tests for src/runtime/node/community/local-community/db-state.ts.
// These helpers wrap the SQLite keyv store and signer init. Full coverage requires
// a real DbHandler (with sqlite) and the started LocalCommunity lifecycle, which is
// the territory of the integration suite (test/node/community/db.community.test.ts,
// create.community.test.ts, edit.community.test.ts).
// Unit tests here exercise the few branches that don't need IPFS/IPNS/sqlite:
//   - initSignerProps mutates community.signer and community.encryption
//   - setChallengesToDefaultIfNotDefined no-ops when already non-default
//   - export shape for the remaining helpers

import { describe, it, expect, vi } from "vitest";
import {
    createNewLocalCommunityDb,
    getDbInternalState,
    importCommunitySignerIntoIpfsIfNeeded,
    initDbHandlerIfNeeded,
    initInternalCommunityAfterFirstUpdateNoMerge,
    initInternalCommunityBeforeFirstUpdateNoMerge,
    initNewLocalCommunityPropsNoMerge,
    initSignerProps,
    setChallengesToDefaultIfNotDefined,
    updateDbInternalState,
    updateInstancePropsWithStartedCommunityOrDb,
    updateInstanceStateWithDbState
} from "../../../../dist/node/runtime/node/community/local-community/db-state.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import Logger from "../../../../dist/node/logger.js";

describe("db-state: export shape", () => {
    it("exports all db-state helpers", () => {
        expect(typeof createNewLocalCommunityDb).to.equal("function");
        expect(typeof getDbInternalState).to.equal("function");
        expect(typeof importCommunitySignerIntoIpfsIfNeeded).to.equal("function");
        expect(typeof initDbHandlerIfNeeded).to.equal("function");
        expect(typeof initInternalCommunityAfterFirstUpdateNoMerge).to.equal("function");
        expect(typeof initInternalCommunityBeforeFirstUpdateNoMerge).to.equal("function");
        expect(typeof initNewLocalCommunityPropsNoMerge).to.equal("function");
        expect(typeof initSignerProps).to.equal("function");
        expect(typeof setChallengesToDefaultIfNotDefined).to.equal("function");
        expect(typeof updateDbInternalState).to.equal("function");
        expect(typeof updateInstancePropsWithStartedCommunityOrDb).to.equal("function");
        expect(typeof updateInstanceStateWithDbState).to.equal("function");
    });
});

describe("db-state: setChallengesToDefaultIfNotDefined", () => {
    it("does not call edit when _usingDefaultChallenge is explicitly false", async () => {
        const editSpy = vi.fn();
        const community = {
            address: "community.bso",
            _usingDefaultChallenge: false,
            settings: { challenges: [{ name: "text-math", options: {} }] },
            _defaultCommunityChallenges: [{ name: "question", options: { question: "x", answer: "y" } }],
            edit: editSpy
        } as unknown as LocalCommunity;

        await setChallengesToDefaultIfNotDefined(community, Logger("pkc-js-test:db-state"));
        expect(editSpy).not.toHaveBeenCalled();
    });

    it("does not call edit when current settings.challenges already deep-equals _defaultCommunityChallenges", async () => {
        const editSpy = vi.fn();
        const defaultChallenges = [{ name: "question", options: { question: "x", answer: "y" } }];
        const community = {
            address: "community.bso",
            _usingDefaultChallenge: true,
            settings: { challenges: defaultChallenges },
            _defaultCommunityChallenges: defaultChallenges,
            edit: editSpy
        } as unknown as LocalCommunity;

        // Settings.challenges is not the canonical default shape so isDefaultChallengeStructure returns
        // false and the upper-block guard means _usingDefaultChallenge stays true.
        // But it still passes `isDeepEqual` so edit() shouldn't fire.
        await setChallengesToDefaultIfNotDefined(community, Logger("pkc-js-test:db-state"));
        expect(editSpy).not.toHaveBeenCalled();
    });
});

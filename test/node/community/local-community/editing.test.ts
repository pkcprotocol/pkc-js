// Unit tests for src/runtime/node/community/local-community/editing.ts.
// edit() / editPropsOnStartedCommunity / editPropsOnNotStartedCommunity orchestrate
// db + ipfs + registry mutation and have substantial integration coverage under
// test/node/community/edit.community.test.ts. Unit tests here focus on the leaf
// helpers (parseRolesToEdit, parseChallengesToEdit, movePostUpdatesFolderToNewAddress,
// validateNewAddressBeforeEditing) with stubbed dependencies.

import { describe, it, expect, vi } from "vitest";
import {
    edit,
    editPropsOnNotStartedCommunity,
    editPropsOnStartedCommunity,
    movePostUpdatesFolderToNewAddress,
    parseChallengesToEdit,
    parseRolesToEdit,
    validateNewAddressBeforeEditing
} from "../../../../dist/node/runtime/node/community/local-community/editing.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommunityEditOptions } from "../../../../dist/node/community/types.js";
import { PKCError } from "../../../../dist/node/pkc-error.js";
import Logger from "../../../../dist/node/logger.js";

describe("editing: export shape", () => {
    it("exports all editing helpers", () => {
        expect(typeof edit).to.equal("function");
        expect(typeof editPropsOnNotStartedCommunity).to.equal("function");
        expect(typeof editPropsOnStartedCommunity).to.equal("function");
        expect(typeof movePostUpdatesFolderToNewAddress).to.equal("function");
        expect(typeof parseChallengesToEdit).to.equal("function");
        expect(typeof parseRolesToEdit).to.equal("function");
        expect(typeof validateNewAddressBeforeEditing).to.equal("function");
    });
});

describe("editing: parseRolesToEdit", () => {
    it("omits roleAddresses whose value is undefined/null (i.e. role removals)", async () => {
        const community = {
            _clientsManager: { resolveAuthorNameIfNeeded: vi.fn() },
            _pkc: { _timeouts: { "resolve-author-name": 1000 } }
        } as unknown as LocalCommunity;

        const raw: NonNullable<CommunityEditOptions["roles"]> = {
            "12D3KoooSignerAddress1": { role: "moderator" },
            // null/undefined entries get pruned
            "12D3KoooSignerAddress2": null as unknown as { role: "moderator" }
        };

        const result = await parseRolesToEdit(community, raw);
        expect(result).to.deep.equal({ "12D3KoooSignerAddress1": { role: "moderator" } });
    });

    it("throws ERR_ROLE_ADDRESS_NAME_COULD_NOT_BE_RESOLVED when a domain role address can't resolve", async () => {
        const community = {
            _clientsManager: {
                resolveAuthorNameIfNeeded: vi.fn().mockResolvedValue({ resolvedAuthorName: null })
            },
            _pkc: { _timeouts: { "resolve-author-name": 1000 } }
        } as unknown as LocalCommunity;

        const raw: NonNullable<CommunityEditOptions["roles"]> = {
            "alice.eth": { role: "moderator" }
        };

        await expect(parseRolesToEdit(community, raw)).rejects.toThrow(PKCError);
    });

    it("does not call the resolver for non-domain role addresses", async () => {
        const resolveAuthorNameIfNeeded = vi.fn();
        const community = {
            _clientsManager: { resolveAuthorNameIfNeeded },
            _pkc: { _timeouts: { "resolve-author-name": 1000 } }
        } as unknown as LocalCommunity;

        await parseRolesToEdit(community, { "12D3KoooSomeSignerKey": { role: "admin" } } as unknown as NonNullable<
            CommunityEditOptions["roles"]
        >);

        expect(resolveAuthorNameIfNeeded).not.toHaveBeenCalled();
    });
});

describe("editing: parseChallengesToEdit", () => {
    it("returns _usingDefaultChallenge=false for non-default challenge settings", async () => {
        const community = {
            _pkc: { plugins: undefined }
        } as unknown as LocalCommunity;

        // text-math is not the default-question challenge, so _usingDefaultChallenge should be false.
        const result = await parseChallengesToEdit(community, [{ name: "text-math", options: {} }]);
        expect(result._usingDefaultChallenge).to.equal(false);
        expect(Array.isArray(result.challenges)).to.equal(true);
    });
});

describe("editing: validateNewAddressBeforeEditing", () => {
    it("rejects domain addresses that contain capital letters", async () => {
        const log = Logger("pkc-js-test:editing");
        const community = {
            address: "old.bso",
            _pkc: { communities: [] },
            _assertDomainResolvesCorrectly: vi.fn().mockResolvedValue(undefined)
        } as unknown as LocalCommunity;

        await expect(validateNewAddressBeforeEditing(community, "MixedCase.bso", log)).rejects.toThrow(PKCError);
    });

    it("rejects when an equivalent address already exists in pkc.communities", async () => {
        const log = Logger("pkc-js-test:editing");
        const community = {
            address: "old.bso",
            // pkc.communities is a string[] of community addresses (see Pkc.communities).
            _pkc: { communities: ["new.bso"] },
            _assertDomainResolvesCorrectly: vi.fn().mockResolvedValue(undefined)
        } as unknown as LocalCommunity;

        await expect(validateNewAddressBeforeEditing(community, "new.bso", log)).rejects.toThrow(PKCError);
    });

    it("passes through for a fresh lowercase address", async () => {
        const log = Logger("pkc-js-test:editing");
        const assertSpy = vi.fn().mockResolvedValue(undefined);
        const community = {
            address: "old.bso",
            _pkc: { communities: ["old.bso"] },
            _assertDomainResolvesCorrectly: assertSpy
        } as unknown as LocalCommunity;

        // Should not throw — note _assertDomainResolvesCorrectly is called fire-and-forget.
        await validateNewAddressBeforeEditing(community, "new.bso", log);
        // assertSpy is invoked synchronously inside the helper (we don't await it).
        expect(assertSpy).toHaveBeenCalledWith("new.bso");
    });
});

describe("editing: movePostUpdatesFolderToNewAddress", () => {
    it("calls files.mv with old and new MFS paths", async () => {
        const mv = vi.fn().mockResolvedValue(undefined);
        const community = {
            address: "community.bso",
            _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: { files: { mv } } }) }
        } as unknown as LocalCommunity;

        await movePostUpdatesFolderToNewAddress(community, "old.bso", "new.bso");
        expect(mv).toHaveBeenCalledWith("/old.bso", "/new.bso");
    });

    it("swallows a 'file does not exist' error (folder may not have been created yet)", async () => {
        const mv = vi.fn().mockRejectedValue(new Error("file does not exist"));
        const community = {
            address: "community.bso",
            _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: { files: { mv } } }) }
        } as unknown as LocalCommunity;

        await movePostUpdatesFolderToNewAddress(community, "old.bso", "new.bso");
        expect(mv).toHaveBeenCalled();
    });

    it("rethrows non-'file does not exist' kubo errors", async () => {
        const mv = vi.fn().mockRejectedValue(new Error("kubo: permission denied"));
        const community = {
            address: "community.bso",
            _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: { files: { mv } } }) }
        } as unknown as LocalCommunity;

        await expect(movePostUpdatesFolderToNewAddress(community, "old.bso", "new.bso")).rejects.toThrow("permission denied");
    });
});

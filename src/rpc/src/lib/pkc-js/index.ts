// NOTE: don't import pkc-js directly to be able to replace the implementation

// @pkcprotocol/pkc-js imported from parent folder
import PKC from "../../../../index.js";

import assert from "assert";

const PKCJs = {
    PKC: PKC
};

/**
 * replace PKCJs with a different implementation, for
 * example to mock it during unit tests, to add mock content
 * for developing the front-end or to add a PKCJs with
 * desktop privileges in the Electron build.
 */
export function setPKCJs(_PKC: any) {
    assert(typeof _PKC === "function", `setPKCJs invalid PKC argument '${_PKC}' not a function`);
    // Preserve built-in challenge and page sort registries for RPC settings serialization when tests inject a plain function.
    if (_PKC.challenges === undefined) _PKC.challenges = PKC.challenges;
    if (_PKC.pageSorts === undefined) _PKC.pageSorts = PKC.pageSorts;
    PKCJs.PKC = _PKC;
}

export function restorePKCJs() {
    PKCJs.PKC = PKC;
}

export default PKCJs;

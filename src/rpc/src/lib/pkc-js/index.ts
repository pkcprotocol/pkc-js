// NOTE: don't import plebbit-js directly to be able to replace the implementation

// @plebbit/plebbit-js imported from parent folder
import PKC from "../../../../index.js";

import assert from "assert";
import Logger from "../../../../logger.js";
const log = Logger("pkc-react-hooks:pkc-js");

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
    // Preserve built-in challenge registry for RPC settings serialization when tests inject a plain function.
    if (_PKC.challenges === undefined) _PKC.challenges = PKC.challenges;
    PKCJs.PKC = _PKC;
    log("setPKCJs", _PKC?.constructor?.name);
}

export function restorePKCJs() {
    PKCJs.PKC = PKC;
    log("restorePKCJs");
}

export default PKCJs;

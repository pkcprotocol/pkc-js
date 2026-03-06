import type { GenericClientEvents } from "../types.js";
import { hideClassPrivateProps } from "../util.js";
import { PlebbitTypedEmitter } from "./plebbit-typed-emitter.js";

type NameResolverState = "stopped" | "resolving-author-address" | "resolving-subplebbit-address";

export class NameResolverClient extends PlebbitTypedEmitter<GenericClientEvents<NameResolverState>> {
    override state: NameResolverState;

    constructor(state: NameResolverState) {
        super();
        this.state = state;
        hideClassPrivateProps(this);
    }
}

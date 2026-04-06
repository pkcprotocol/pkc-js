import { PlebbitTypedEmitter } from "./clients/pkc-typed-emitter.js";
import { GenericClientEvents } from "./types.js";
import { hideClassPrivateProps } from "./util.js";

export class GenericStateClient<T extends string> extends PlebbitTypedEmitter<GenericClientEvents<T>> {
    override state: T;

    constructor(state: T) {
        super();
        this.state = state;
        this.setMaxListeners(100);
        hideClassPrivateProps(this);
    }
}

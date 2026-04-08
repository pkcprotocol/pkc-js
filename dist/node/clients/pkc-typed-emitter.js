import { TypedEmitter } from "tiny-typed-emitter";
import { hideClassPrivateProps } from "../util.js";
export class PKCTypedEmitter extends TypedEmitter {
    constructor() {
        super();
        this._mirroredClient = undefined;
        this._stateListener = undefined;
        hideClassPrivateProps(this);
    }
    mirror(sourceClient) {
        if (this._mirroredClient) {
            throw new Error("This client is already mirroring another client");
        }
        // Mirror initial state
        if (sourceClient.state !== this.state) {
            this.state = sourceClient.state;
            //@ts-expect-error
            this.emit("statechange", this.state);
        }
        // Setup state change listener
        this._stateListener = (newState) => {
            this.state = newState;
            //@ts-expect-error
            this.emit("statechange", newState);
        };
        // Listen to state changes on source client
        //@ts-expect-error
        sourceClient.on("statechange", this._stateListener);
        // Store reference to source client
        this._mirroredClient = sourceClient;
    }
    unmirror() {
        if (!this._mirroredClient || !this._stateListener) {
            return;
            throw new Error("This client is not mirroring any other client");
        }
        // Remove state change listener
        //@ts-expect-error
        this._mirroredClient.off("statechange", this._stateListener);
        // // Reset to stopped state
        if (this.state !== "stopped") {
            //@ts-expect-error
            this.state = "stopped";
            //@ts-expect-error
            this.emit("statechange", this.state);
        }
        // Clear references
        this._stateListener = undefined;
        this._mirroredClient = undefined;
    }
}
//# sourceMappingURL=pkc-typed-emitter.js.map
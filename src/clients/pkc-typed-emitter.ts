import { ListenerSignature, TypedEmitter } from "tiny-typed-emitter";
import { hideClassPrivateProps } from "../util.js";

export class PlebbitTypedEmitter<T extends ListenerSignature<T>> extends TypedEmitter<T> {
    _mirroredClient?: PlebbitTypedEmitter<T> = undefined;
    state: any;
    private _stateListener?: (newState: string) => void = undefined;

    constructor() {
        super();
        hideClassPrivateProps(this);
    }

    mirror(sourceClient: PlebbitTypedEmitter<T>): void {
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
        this._stateListener = (newState: string) => {
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
            this.state = "stopped" as T;
            //@ts-expect-error
            this.emit("statechange", this.state);
        }

        // Clear references
        this._stateListener = undefined;
        this._mirroredClient = undefined;
    }
}

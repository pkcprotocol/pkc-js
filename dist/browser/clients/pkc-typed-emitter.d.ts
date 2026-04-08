import { ListenerSignature, TypedEmitter } from "tiny-typed-emitter";
export declare class PKCTypedEmitter<T extends ListenerSignature<T>> extends TypedEmitter<T> {
    _mirroredClient?: PKCTypedEmitter<T>;
    state: any;
    private _stateListener?;
    constructor();
    mirror(sourceClient: PKCTypedEmitter<T>): void;
    unmirror(): void;
}

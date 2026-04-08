import { PKCTypedEmitter } from "./clients/pkc-typed-emitter.js";
import { hideClassPrivateProps } from "./util.js";
export class GenericStateClient extends PKCTypedEmitter {
    constructor(state) {
        super();
        this.state = state;
        this.setMaxListeners(100);
        hideClassPrivateProps(this);
    }
}
//# sourceMappingURL=generic-state-client.js.map
import { hideClassPrivateProps } from "../util.js";
import { PKCTypedEmitter } from "./pkc-typed-emitter.js";
export class NameResolverClient extends PKCTypedEmitter {
    constructor(state) {
        super();
        this.state = state;
        hideClassPrivateProps(this);
    }
}
//# sourceMappingURL=name-resolver-client.js.map
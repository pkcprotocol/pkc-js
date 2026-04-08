import Publication from "../publication.js";
import { hideClassPrivateProps } from "../../util.js";
import { PKCError } from "../../pkc-error.js";
import { signCommunityEdit, verifyCommunityEdit } from "../../signer/signatures.js";
// communityEdit.signer is inherited from Publication
class CommunityEdit extends Publication {
    constructor(pkc) {
        super(pkc);
        this.raw = {};
        // public method should be bound
        this.publish = this.publish.bind(this);
        hideClassPrivateProps(this);
    }
    _initUnsignedLocalProps(opts) {
        super._initUnsignedLocalProps(opts);
        const o = opts.unsignedOptions;
        this.communityEdit = o.communityEdit;
    }
    _initLocalProps(props) {
        this._initRemoteProps(props.communityEdit);
        this.challengeRequest = props.challengeRequest;
        this.signer = props.signer;
    }
    async _signPublicationOptionsToPublish(cleanedPublication) {
        return signCommunityEdit({
            communityEdit: cleanedPublication,
            pkc: this._pkc
        });
    }
    _initRemoteProps(props) {
        super._initBaseRemoteProps(props);
        this.communityEdit = props.communityEdit;
        this.raw.pubsubMessageToPublish = props;
    }
    getType() {
        return "communityEdit";
    }
    async _validateSignatureHook() {
        const communityEditObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish)); // Stringified here to simulate a message sent through IPNS/PUBSUB
        const signatureValidity = await verifyCommunityEdit({
            communityEdit: communityEditObj,
            resolveAuthorNames: this._pkc.resolveAuthorNames,
            clientsManager: this._clientsManager
        });
        if (!signatureValidity.valid)
            throw new PKCError("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }
}
export default CommunityEdit;
//# sourceMappingURL=community-edit.js.map
import Publication from "../publication.js";
import type { PublicationTypeName } from "../../types.js";
import { Plebbit } from "../../plebbit/plebbit.js";
import { hideClassPrivateProps, throwWithErrorCode } from "../../util.js";
import type { CreateSubplebbitEditPublicationOptions, SubplebbitEditPubsubMessagePublication } from "./types.js";
import type { SignerType } from "../../signer/types.js";
import { verifySubplebbitEdit } from "../../signer/signatures.js";

// subplebbitEdit.signer is inherited from Publication
class SubplebbitEdit extends Publication implements SubplebbitEditPubsubMessagePublication {
    subplebbitEdit!: SubplebbitEditPubsubMessagePublication["subplebbitEdit"];
    override signature!: SubplebbitEditPubsubMessagePublication["signature"];

    override raw: { pubsubMessageToPublish?: SubplebbitEditPubsubMessagePublication } = {};
    override challengeRequest?: CreateSubplebbitEditPublicationOptions["challengeRequest"];

    constructor(plebbit: Plebbit) {
        super(plebbit);

        // public method should be bound
        this.publish = this.publish.bind(this);

        hideClassPrivateProps(this);
    }

    _initLocalProps(props: {
        subplebbitEdit: SubplebbitEditPubsubMessagePublication;
        signer?: SignerType;
        challengeRequest?: CreateSubplebbitEditPublicationOptions["challengeRequest"];
    }): void {
        this._initRemoteProps(props.subplebbitEdit);
        this.challengeRequest = props.challengeRequest;
        this.signer = props.signer;
    }

    _initRemoteProps(props: SubplebbitEditPubsubMessagePublication): void {
        super._initBaseRemoteProps(props);
        this.subplebbitEdit = props.subplebbitEdit;
        this.raw.pubsubMessageToPublish = props;
    }

    override toJSONPubsubMessagePublication(): SubplebbitEditPubsubMessagePublication {
        if (!this.raw.pubsubMessageToPublish) throw Error("Should define local props before calling toJSONPubsubMessagePublication");
        return this.raw.pubsubMessageToPublish;
    }

    override getType(): PublicationTypeName {
        return "subplebbitEdit";
    }

    private async _validateSignature() {
        const subplebbitEditObj = JSON.parse(JSON.stringify(this.toJSONPubsubMessagePublication())); // Stringified here to simulate a message sent through IPNS/PUBSUB
        const signatureValidity = await verifySubplebbitEdit({
            subplebbitEdit: subplebbitEditObj,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            clientsManager: this._clientsManager
        });
        if (!signatureValidity.valid) throwWithErrorCode("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }

    override async publish(): Promise<void> {
        await this._validateSignature();
        return super.publish();
    }
}

export default SubplebbitEdit;

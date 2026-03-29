import Publication from "../publication.js";
import type { PublicationTypeName } from "../../types.js";
import { Plebbit } from "../../plebbit/plebbit.js";
import { hideClassPrivateProps } from "../../util.js";
import { PlebbitError } from "../../plebbit-error.js";
import type {
    CreateSubplebbitEditPublicationOptions,
    SubplebbitEditPublicationOptionsToSign,
    SubplebbitEditPubsubMessagePublication
} from "./types.js";
import type { SignerType } from "../../signer/types.js";
import { signSubplebbitEdit, verifySubplebbitEdit } from "../../signer/signatures.js";
import type { CreatePublicationOptions } from "../../types.js";

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

    override _initUnsignedLocalProps<
        T extends {
            signer: SignerType;
            communityAddress: string;
            timestamp: number;
            protocolVersion: string;
            author?: Record<string, unknown>;
        }
    >(opts: { unsignedOptions: T; challengeRequest?: CreatePublicationOptions["challengeRequest"] }) {
        super._initUnsignedLocalProps(opts);
        const o = opts.unsignedOptions as unknown as SubplebbitEditPublicationOptionsToSign;
        this.subplebbitEdit = o.subplebbitEdit;
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

    protected override async _signPublicationOptionsToPublish(
        cleanedPublication: unknown
    ): Promise<SubplebbitEditPubsubMessagePublication["signature"]> {
        return signSubplebbitEdit({
            subplebbitEdit: cleanedPublication as SubplebbitEditPublicationOptionsToSign,
            plebbit: this._plebbit
        });
    }

    _initRemoteProps(props: SubplebbitEditPubsubMessagePublication): void {
        super._initBaseRemoteProps(props);
        this.subplebbitEdit = props.subplebbitEdit;
        this.raw.pubsubMessageToPublish = props;
    }

    override getType(): PublicationTypeName {
        return "subplebbitEdit";
    }

    protected override async _validateSignatureHook() {
        const subplebbitEditObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish!)); // Stringified here to simulate a message sent through IPNS/PUBSUB
        const signatureValidity = await verifySubplebbitEdit({
            subplebbitEdit: subplebbitEditObj,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            clientsManager: this._clientsManager
        });
        if (!signatureValidity.valid) throw new PlebbitError("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
    }
}

export default SubplebbitEdit;

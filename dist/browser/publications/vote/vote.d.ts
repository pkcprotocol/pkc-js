import Publication from "../publication.js";
import type { PublicationTypeName } from "../../types.js";
import { PKC } from "../../pkc/pkc.js";
import type { CreateVoteOptions, VotePubsubMessagePublication } from "./types.js";
import type { SignerType } from "../../signer/types.js";
import type { CreatePublicationOptions } from "../../types.js";
declare class Vote extends Publication implements VotePubsubMessagePublication {
    commentCid: VotePubsubMessagePublication["commentCid"];
    vote: VotePubsubMessagePublication["vote"];
    signature: VotePubsubMessagePublication["signature"];
    raw: {
        pubsubMessageToPublish?: VotePubsubMessagePublication;
    };
    challengeRequest?: CreateVoteOptions["challengeRequest"];
    constructor(pkc: PKC);
    _initUnsignedLocalProps<T extends {
        signer: SignerType;
        communityAddress: string;
        timestamp: number;
        protocolVersion: string;
        author?: Record<string, unknown>;
    }>(opts: {
        unsignedOptions: T;
        challengeRequest?: CreatePublicationOptions["challengeRequest"];
    }): void;
    _initLocalProps(props: {
        vote: VotePubsubMessagePublication;
        signer?: SignerType;
        challengeRequest?: CreateVoteOptions["challengeRequest"];
    }): void;
    protected _signPublicationOptionsToPublish(cleanedPublication: unknown): Promise<VotePubsubMessagePublication["signature"]>;
    _initRemoteProps(props: VotePubsubMessagePublication): void;
    getType(): PublicationTypeName;
    protected _validateSignatureHook(): Promise<void>;
}
export default Vote;

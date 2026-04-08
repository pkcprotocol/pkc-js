import { PKC } from "../../pkc/pkc.js";
import Publication from "../publication.js";
import type { CommentModerationPubsubMessagePublication, CreateCommentModerationOptions } from "./types.js";
import type { PublicationTypeName } from "../../types.js";
import type { SignerType } from "../../signer/types.js";
import type { CreatePublicationOptions } from "../../types.js";
export declare class CommentModeration extends Publication implements CommentModerationPubsubMessagePublication {
    commentCid: CommentModerationPubsubMessagePublication["commentCid"];
    commentModeration: CommentModerationPubsubMessagePublication["commentModeration"];
    signature: CommentModerationPubsubMessagePublication["signature"];
    raw: {
        pubsubMessageToPublish?: CommentModerationPubsubMessagePublication;
    };
    challengeRequest?: CreateCommentModerationOptions["challengeRequest"];
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
        commentModeration: CommentModerationPubsubMessagePublication;
        signer?: SignerType;
        challengeRequest?: CreateCommentModerationOptions["challengeRequest"];
    }): void;
    protected _signPublicationOptionsToPublish(cleanedPublication: unknown): Promise<CommentModerationPubsubMessagePublication["signature"]>;
    _initPubsubPublication(pubsubMsgPub: CommentModerationPubsubMessagePublication): void;
    getType(): PublicationTypeName;
    protected _validateSignatureHook(): Promise<void>;
    publish(): Promise<void>;
}

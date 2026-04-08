import { z } from "zod";
export declare const CreateVoteUserOptionsSchema: z.ZodObject<{
    signer: z.ZodObject<{
        type: z.ZodEnum<{
            ed25519: "ed25519";
        }>;
        privateKey: z.ZodString;
    }, z.core.$strip>;
    author: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        previousCommentCid: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        displayName: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        wallets: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            address: z.ZodString;
            timestamp: z.ZodNumber;
            signature: z.ZodObject<{
                signature: z.ZodString;
                type: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>>>>;
        avatar: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            chainTicker: z.ZodString;
            address: z.ZodString;
            id: z.ZodString;
            timestamp: z.ZodNumber;
            signature: z.ZodObject<{
                signature: z.ZodString;
                type: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$loose>>>;
        flairs: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodObject<{
            text: z.ZodString;
            backgroundColor: z.ZodOptional<z.ZodString>;
            textColor: z.ZodOptional<z.ZodString>;
            expiresAt: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>>>;
    }, z.core.$loose>>;
    communityAddress: z.ZodString;
    communityPublicKey: z.ZodOptional<z.ZodString>;
    communityName: z.ZodOptional<z.ZodString>;
    protocolVersion: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodOptional<z.ZodNumber>;
    challengeRequest: z.ZodOptional<z.ZodObject<{
        challengeAnswers: z.ZodOptional<z.ZodArray<z.ZodString>>;
        challengeCommentCids: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    commentCid: z.ZodString;
    vote: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<0>, z.ZodLiteral<-1>]>;
}, z.core.$strict>;
export declare const VoteSignedPropertyNames: ("timestamp" | "author" | "communityPublicKey" | "communityName" | "protocolVersion" | "commentCid" | "vote")[];
export declare const VotePubsubMessagePublicationSchema: z.ZodObject<{
    timestamp: z.ZodNumber;
    signature: z.ZodObject<{
        type: z.ZodString;
        signature: z.ZodString;
        publicKey: z.ZodString;
        signedPropertyNames: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    author: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        previousCommentCid: z.ZodOptional<z.ZodString>;
        displayName: z.ZodOptional<z.ZodString>;
        wallets: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            address: z.ZodString;
            timestamp: z.ZodNumber;
            signature: z.ZodObject<{
                signature: z.ZodString;
                type: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>>>;
        avatar: z.ZodOptional<z.ZodObject<{
            chainTicker: z.ZodString;
            address: z.ZodString;
            id: z.ZodString;
            timestamp: z.ZodNumber;
            signature: z.ZodObject<{
                signature: z.ZodString;
                type: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$loose>>;
        flairs: z.ZodOptional<z.ZodArray<z.ZodObject<{
            text: z.ZodString;
            backgroundColor: z.ZodOptional<z.ZodString>;
            textColor: z.ZodOptional<z.ZodString>;
            expiresAt: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>>;
    }, z.core.$loose>>;
    communityPublicKey: z.ZodOptional<z.ZodString>;
    communityName: z.ZodOptional<z.ZodString>;
    protocolVersion: z.ZodString;
    commentCid: z.ZodString;
    vote: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<0>, z.ZodLiteral<-1>]>;
}, z.core.$strict>;
export declare const VoteTablesRowSchema: z.ZodObject<{
    timestamp: z.ZodNumber;
    protocolVersion: z.ZodString;
    commentCid: z.ZodString;
    vote: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<0>, z.ZodLiteral<-1>]>;
    insertedAt: z.ZodNumber;
    authorSignerAddress: z.ZodString;
    extraProps: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
}, z.core.$strict>;
export declare const VoteChallengeRequestToEncryptSchema: z.ZodObject<{
    challengeAnswers: z.ZodOptional<z.ZodArray<z.ZodString>>;
    challengeCommentCids: z.ZodOptional<z.ZodArray<z.ZodString>>;
    vote: z.ZodObject<{
        timestamp: z.ZodNumber;
        signature: z.ZodObject<{
            type: z.ZodString;
            signature: z.ZodString;
            publicKey: z.ZodString;
            signedPropertyNames: z.ZodArray<z.ZodString>;
        }, z.core.$strip>;
        author: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            previousCommentCid: z.ZodOptional<z.ZodString>;
            displayName: z.ZodOptional<z.ZodString>;
            wallets: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                address: z.ZodString;
                timestamp: z.ZodNumber;
                signature: z.ZodObject<{
                    signature: z.ZodString;
                    type: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>>>;
            avatar: z.ZodOptional<z.ZodObject<{
                chainTicker: z.ZodString;
                address: z.ZodString;
                id: z.ZodString;
                timestamp: z.ZodNumber;
                signature: z.ZodObject<{
                    signature: z.ZodString;
                    type: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$loose>>;
            flairs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                text: z.ZodString;
                backgroundColor: z.ZodOptional<z.ZodString>;
                textColor: z.ZodOptional<z.ZodString>;
                expiresAt: z.ZodOptional<z.ZodNumber>;
            }, z.core.$loose>>>;
        }, z.core.$loose>>;
        communityPublicKey: z.ZodOptional<z.ZodString>;
        communityName: z.ZodOptional<z.ZodString>;
        protocolVersion: z.ZodString;
        commentCid: z.ZodString;
        vote: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<0>, z.ZodLiteral<-1>]>;
    }, z.core.$loose>;
}, z.core.$strip>;
export declare const VotePubsubReservedFields: string[];

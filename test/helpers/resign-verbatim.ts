// Re-signs a wire publication exactly as it is, with no cleanup: whatever a test put in it is part of the
// signed bytes and every top-level key lands in signedPropertyNames. pkc-js's own signing path runs
// cleanUpBeforePublishing first (empty objects and undefined values are dropped), so this is how a test
// produces what a non-pkc-js or hand-signing client could send (issue #387).
import { _signJson } from "../../dist/node/signer/signatures.js";
import Logger from "@pkcprotocol/pkc-logger";
import type { JsonSignature, SignerType } from "../../dist/node/signer/types.js";

export type WirePublication = Record<string, unknown> & { signature: JsonSignature };

const log = Logger({ namespace: "pkc-js:test:resign-verbatim" });

export async function resignVerbatim(publication: WirePublication, signer: SignerType): Promise<void> {
    const signedPropertyNames = <JsonSignature["signedPropertyNames"]>(
        Array.from(new Set([...publication.signature.signedPropertyNames, ...Object.keys(publication).filter((k) => k !== "signature")]))
    );
    publication.signature = await _signJson(signedPropertyNames, publication, signer, log);
}

export const LONE_SURROGATE = "\ud800";

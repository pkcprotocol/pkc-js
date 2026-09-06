// Pure string helpers for author/community addresses. This module MUST stay dependency-free:
// it is imported by zod schema modules (e.g. src/community/schema.ts), and pulling in
// src/util.ts from a schema module creates an evaluation-order cycle
// (community/schema -> util -> pubsub-messages/schema -> community-edit/schema -> community/schema)
// that throws at import time. See config/verify-module-import-order.js.

export function isStringDomain(x: string | undefined) {
    return typeof x === "string" && x.includes(".");
}

export function isEthAliasDomain(address: string): boolean {
    const lower = address.toLowerCase();
    return lower.endsWith(".eth") || lower.endsWith(".bso");
}

export function normalizeEthAliasDomain(address: string): string {
    return address.endsWith(".bso") ? address.slice(0, -4) + ".eth" : address;
}

import { messages } from "./errors.js";
import { CustomError } from "ts-custom-error";
export class PKCError extends CustomError {
    constructor(code, details) {
        super(messages[code]);
        this.details = {}; // Used to hold key-value of related props. Could be cid of a comment that failed to update
        this.code = code;
        this.message = messages[code];
        this.details = details ?? {};
        this.stack = this.injectDetailsIntoStack(this.stack);
    }
    toString() {
        const formattedDetails = this.formatDetails();
        const detailsSuffix = formattedDetails ? ` Details: ${formattedDetails}` : "";
        const stackSuffix = this.stack ? `\nStack: ${this.stack}` : "";
        return `${this.constructor.name}: ${this.code}: ${this.message}${detailsSuffix}${stackSuffix}`;
    }
    toJSON() {
        return {
            name: this.constructor.name,
            code: this.code,
            message: this.message,
            stack: this.stack,
            details: this.details
        };
    }
    // Custom Node.js util.inspect formatting
    [Symbol.for("nodejs.util.inspect.custom")]() {
        const { stack, ...rest } = this.toJSON();
        return {
            ...rest,
            stack: typeof stack === "string" ? stack.split("\n") : stack
        };
    }
    // Chrome DevTools custom formatting
    [Symbol.for("devtools.formatter.header")]() {
        return [
            "div",
            { style: "color: #d32f2f; font-weight: bold;" },
            ["span", {}, `${this.constructor.name}: `],
            ["span", { style: "color: #1976d2; font-weight: normal;" }, this.code],
            ["span", { style: "color: #333; font-weight: normal; margin-left: 8px;" }, this.message]
        ];
    }
    [Symbol.for("devtools.formatter.hasBody")]() {
        return Object.keys(this.details).length > 0;
    }
    [Symbol.for("devtools.formatter.body")]() {
        const detailsEntries = Object.entries(this.details);
        if (detailsEntries.length === 0) {
            return ["div", {}, "No details available"];
        }
        return [
            "div",
            { style: "margin-top: 8px;" },
            ["div", { style: "font-weight: bold; color: #1976d2; margin-bottom: 4px;" }, "📋 Details:"],
            ...detailsEntries.map(([key, value]) => [
                "div",
                { style: "margin-left: 16px; margin-bottom: 2px;" },
                ["span", { style: "color: #666; font-weight: bold;" }, `${key}: `],
                ["span", { style: "color: #333;" }, typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)]
            ])
        ];
    }
    // Alternative string representation for better console display
    [Symbol.toPrimitive](hint) {
        if (hint === "string") {
            return this.toString();
        }
        return this.message;
    }
    injectDetailsIntoStack(stack) {
        if (!stack) {
            return stack;
        }
        const formattedDetails = this.formatDetails(true);
        if (!formattedDetails) {
            return stack;
        }
        const [firstLine, ...rest] = stack.split("\n");
        const detailsLines = formattedDetails.split("\n");
        const detailsBlock = detailsLines.length === 1 ? `Details: ${detailsLines[0]}` : `Details:\n${detailsLines.map((line) => `  ${line}`).join("\n")}`;
        return [firstLine, detailsBlock, ...rest].join("\n");
    }
    formatDetails(pretty = false) {
        const details = this.details;
        if (details === undefined || details === null) {
            return undefined;
        }
        if (typeof details === "object" && !Array.isArray(details) && Object.keys(details).length === 0) {
            return undefined;
        }
        if (typeof details === "string") {
            return details;
        }
        try {
            return JSON.stringify(details, PKCError.jsonReplacer, pretty ? 2 : undefined);
        }
        catch {
            return String(details);
        }
    }
    static jsonReplacer(_, value) {
        return typeof value === "bigint" ? value.toString() : value;
    }
}
export class FailedToFetchCommunityFromGatewaysError extends PKCError {
    constructor(details) {
        super("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS", details);
        this.details = details;
    }
}
export class FailedToFetchCommentIpfsFromGatewaysError extends PKCError {
    constructor(details) {
        super("ERR_FAILED_TO_FETCH_COMMENT_IPFS_FROM_GATEWAYS", details);
        this.details = details;
    }
}
export class FailedToFetchCommentUpdateFromGatewaysError extends PKCError {
    constructor(details) {
        super("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_GATEWAYS", details);
        this.details = details;
    }
}
export class FailedToFetchPageIpfsFromGatewaysError extends PKCError {
    constructor(details) {
        super("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS", details);
        this.details = details;
    }
}
export class FailedToFetchGenericIpfsFromGatewaysError extends PKCError {
    constructor(details) {
        super("ERR_FAILED_TO_FETCH_GENERIC_IPFS_FROM_GATEWAYS", details);
        this.details = details;
    }
}
//# sourceMappingURL=pkc-error.js.map
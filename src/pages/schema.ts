import { z } from "zod";
import { CidStringSchema } from "../schema/schema.js";
import { CommentIpfsSchema, CommentUpdateForChallengeVerificationSchema, CommentUpdateSchema } from "../publications/comment/schema.js";
import { isReservedObjectKey } from "../object-key-util.js";

// Pages schemas here

export const PageIpfsSchema = z.object({
    comments: z.lazy(() => z.object({ comment: CommentIpfsSchema.loose(), commentUpdate: CommentUpdateSchema.loose() }).array()),
    nextCid: CidStringSchema.optional()
});

// Any non-empty sort name a page-sort package declares (settings.pages, #73), except the ones that are not safe as
// plain-object keys on a client (src/object-key-util.ts)
export const SortNameStringSchema = z
    .string()
    .min(1)
    .refine((name) => !isReservedObjectKey(name), {
        message: "A sort name cannot be __proto__, constructor or prototype, nor any other key an object inherits (toString, valueOf, ...)"
    });

export const PostSortNameSchema = z
    .enum(["hot", "new", "topHour", "topDay", "topWeek", "topMonth", "topYear", "topAll", "active"])
    .or(SortNameStringSchema); // this is added to allow flexibility

// Comment pages here

export const ReplySortNameSchema = z.enum(["best", "new", "old", "newFlat", "oldFlat"]).or(SortNameStringSchema); // this is added to allow flexiblity;

// TODO combine the two into one schema
export const PostsPagesIpfsSchema = z.object({
    pages: z.record(PostSortNameSchema, PageIpfsSchema), // pre loaded pages
    pageCids: z.record(PostSortNameSchema, CidStringSchema).optional() // pageCids is optional if all posts can fit in one preloaded page
});

export const RepliesPagesIpfsSchema = z.object({
    pages: z.record(ReplySortNameSchema, PageIpfsSchema), // pre loaded pages
    pageCids: z.record(ReplySortNameSchema, CidStringSchema).optional() // pageCids is optional if all replies can fit in one preloaded page
});

export const ModQueuePagesIpfsSchema = z.object({
    pageCids: z.record(SortNameStringSchema, CidStringSchema)
});

export const ModQueuePageIpfsSchema = z.object({
    comments: z.lazy(() =>
        z.object({ comment: CommentIpfsSchema.loose(), commentUpdate: CommentUpdateForChallengeVerificationSchema.loose() }).array()
    ),
    nextCid: CidStringSchema.optional()
});

// getPage params
export const GetPageParamSchema = z.object({ cid: CidStringSchema });

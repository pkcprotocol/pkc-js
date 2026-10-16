import { z } from "zod";
import type {
    CommunityListEntrySchema,
    CommunityListIpfsSchema,
    CreateCommunityListOptionsSchema,
    CreateCommunityListWithCidOptionsSchema,
    CreateNewCommunityListOptionsSchema
} from "./schema.js";
import type { PKCError } from "../pkc-error.js";
import type { CommunityList } from "./community-list.js";

export type CommunityListEntryType = z.infer<typeof CommunityListEntrySchema>;
export type CommunityListIpfsType = z.infer<typeof CommunityListIpfsSchema>;
export type CreateNewCommunityListOptions = z.infer<typeof CreateNewCommunityListOptionsSchema>;
export type CreateCommunityListWithCidOptions = z.infer<typeof CreateCommunityListWithCidOptionsSchema>;
export type CreateCommunityListOptions = z.infer<typeof CreateCommunityListOptionsSchema>;

// Entry identity follows the publication convention: wire carries publicKey (+ optional name),
// runtime adds address and shortAddress as conveniences
export type CommunityListEntryJson = CommunityListEntryType & { address: string; shortAddress: string };

export type CommunityListState = "stopped" | "updating" | "publishing";

export interface CommunityListEvents {
    update: (list: CommunityList) => void;
    statechange: (newState: CommunityListState) => void;
    error: (error: PKCError | Error) => void;
}

import { PKCError } from "./pkc-error.js";
import { ChallengeFileFactorySchema, ChallengeFileSchema, PageSortFileFactorySchema } from "./community/schema.js";
import { validatePageSortFile } from "./pages/page-sort-scoring.js";
import type { ChallengeFile, PageSortFile } from "./community/types.js";
import type { Logger } from "@pkcprotocol/pkc-logger";

// For consumers that install challenge and page sort packages (bitsocial-cli's `challenge install` and
// `page-sort install`, issue #412): check a package's default export before registering it, with the same schemas
// the community applies when it loads the factory, so an installer can never accept what a community would reject.
// The factory is called once with only the name; a factory that needs options to construct is invalid anyway, since
// the RPC server lists every registered factory the same way. A factory always receives a logger (issue #625), so the
// installer passes its own `log`; the factory gets a child of it under the package's namespace, as a community's would.

export function validateChallengeFileFactory(factory: unknown, { name, log }: { name: string; log: Logger }): ChallengeFile {
    try {
        ChallengeFileFactorySchema.parse(factory);
    } catch (error) {
        throw new PKCError("ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY", { name, error });
    }
    try {
        return ChallengeFileSchema.parse(
            (factory as (args: { challengeSettings: { name: string }; log: Logger }) => unknown)({
                challengeSettings: { name },
                log: log.child({ namespace: `challenge:${name}` })
            })
        );
    } catch (error) {
        throw new PKCError("ERR_CHALLENGE_FILE_INVALID", { name, error });
    }
}

export function validatePageSortFileFactory(factory: unknown, { name, log }: { name: string; log: Logger }): PageSortFile {
    try {
        PageSortFileFactorySchema.parse(factory);
    } catch (error) {
        throw new PKCError("ERR_FAILED_TO_IMPORT_PAGE_SORT_FILE_FACTORY", { name, error });
    }
    try {
        return validatePageSortFile(
            (factory as (args: { pageSortSettings: { name: string }; log: Logger }) => unknown)({
                pageSortSettings: { name },
                log: log.child({ namespace: `page-sort:${name}` })
            })
        );
    } catch (error) {
        throw new PKCError("ERR_PAGE_SORT_FILE_INVALID", { name, error });
    }
}

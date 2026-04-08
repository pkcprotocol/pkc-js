import { derivePublicationFromChallengeRequest } from "../../../../../util.js";
import * as remeda from "remeda";
const defaultDescription = "Match publication properties against regex patterns.";
const optionInputs = [
    {
        option: "matches",
        label: "Matches",
        default: "[]",
        description: "JSON array of property name and regex pattern pairs to match against the publication.",
        placeholder: `[{"propertyName":"author.address","regexp":"\\.bso$"},{"propertyName":"content","regexp":"badword1|badword2|badword3"}]`
    },
    {
        option: "error",
        label: "Error",
        default: "Publication does not match required patterns.",
        description: "The error to display to the author when a match fails.",
        placeholder: "Publication does not match required patterns."
    },
    {
        option: "matchAll",
        label: "Match All",
        default: "true",
        description: "If true, all patterns must match. If false, at least one pattern must match.",
        placeholder: "true"
    },
    {
        option: "description",
        label: "Description",
        default: defaultDescription,
        description: "Custom description for the challenge that explains what patterns are being matched.",
        placeholder: "Authors must have .bso addresses"
    }
];
const type = "text/plain";
const getChallenge = async ({ challengeSettings, challengeRequestMessage }) => {
    // Get the publication from the challenge request
    const publication = derivePublicationFromChallengeRequest(challengeRequestMessage);
    if (!publication) {
        return {
            success: false,
            error: "Could not derive publication from challenge request."
        };
    }
    // Get the matches from the options
    let matches = [];
    try {
        const matchesStr = challengeSettings?.options?.matches;
        if (matchesStr) {
            matches = JSON.parse(matchesStr);
        }
    }
    catch (e) {
        return {
            success: false,
            error: `Invalid matches JSON: ${e.message}`
        };
    }
    // If no matches are defined, the challenge passes
    if (!matches.length) {
        return { success: true };
    }
    // Get the error message
    const error = challengeSettings?.options?.error || "Publication does not match required patterns.";
    // Get the matchAll option (default to true)
    const matchAllStr = challengeSettings?.options?.matchAll;
    const matchAll = matchAllStr !== undefined ? matchAllStr.toLowerCase() === "true" : true;
    // Check each match
    const matchResults = [];
    for (const match of matches) {
        const { propertyName, regexp } = match;
        // Get the property value using remeda.pathOr with stringToPath to handle nested properties
        const pathSegments = remeda.stringToPath(propertyName);
        //@ts-expect-error
        const value = remeda.pathOr(publication, pathSegments, undefined);
        // If property doesn't exist, consider it a failure
        if (value === undefined) {
            matchResults.push({
                success: false,
                propertyName,
                regexp,
                value: undefined
            });
            // If matchAll is true and we have a failure, we can return early
            if (matchAll) {
                return {
                    success: false,
                    error
                };
            }
            continue;
        }
        // Convert value to string for regex matching
        const valueStr = String(value);
        // Create regex and test
        try {
            const regex = new RegExp(regexp);
            const success = regex.test(valueStr);
            matchResults.push({
                success,
                propertyName,
                regexp,
                value: valueStr
            });
            // If matchAll is true and we have a failure, we can return early
            if (matchAll && !success) {
                return {
                    success: false,
                    error
                };
            }
        }
        catch (e) {
            return {
                success: false,
                error: `Invalid regex pattern '${regexp}': ${e.message}`
            };
        }
    }
    // If matchAll is true, all must succeed (we already returned if any failed)
    // If matchAll is false, at least one must succeed
    const success = matchAll || matchResults.some((result) => result.success);
    if (success)
        return { success };
    else
        return {
            success,
            error
        };
};
function ChallengeFileFactory({ challengeSettings }) {
    const description = challengeSettings?.options?.description || defaultDescription;
    return { getChallenge, optionInputs, type, description };
}
export default ChallengeFileFactory;
//# sourceMappingURL=publication-match.js.map
import type { CommunityChallengeSetting } from "../../../../../community/types.js";

// Shared by the blacklist and whitelist challenges, which take the same `addresses` and `urls` options in
// the same comma separated form.

const splitCommaSeparated = (value: string): string[] => value.split(",").map((entry) => entry.trim());

// The only consumer of `urls` is fetch(), so anything that is not a parseable http(s) URL is a guaranteed
// silent failure: fetchAndUpdateUrlSet swallows every error, and the remote list simply never loads.
export function validateAddressListOptions({ challengeSettings }: { challengeSettings: CommunityChallengeSetting }): void {
    const { addresses, urls } = challengeSettings.options ?? {};

    if (addresses)
        for (const [index, address] of splitCommaSeparated(addresses).entries())
            if (!address) throw new Error(`addresses entry ${index} is empty, check for a stray or trailing comma`);

    if (urls)
        for (const [index, url] of splitCommaSeparated(urls).entries()) {
            if (!url) throw new Error(`urls entry ${index} is empty, check for a stray or trailing comma`);
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                throw new Error(`urls entry ${index} ('${url}') is not a valid URL`);
            }
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
                throw new Error(`urls entry ${index} ('${url}') must use http: or https:, it is fetched over HTTP`);
        }
}

export class LocalCommunity {
    constructor() {
        throw Error("Local Community should not be instantiated in browser");
    }
}

export function createNewLocalCommunityDb(): never {
    throw Error("Local Community should not be used in browser");
}

export function updateInstancePropsWithStartedCommunityOrDb(): never {
    throw Error("Local Community should not be used in browser");
}

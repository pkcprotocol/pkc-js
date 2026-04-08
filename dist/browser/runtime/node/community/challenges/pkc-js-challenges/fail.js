// the purpose of this challenge is to always fail, can be used with CommunityChallenge.exclude to whitelist users
const optionInputs = [
    {
        option: "error",
        label: "Error",
        default: `You're not allowed to publish.`,
        description: "The error to display to the author.",
        placeholder: `You're not allowed to publish.`
    }
];
const type = "text/plain";
const description = "A challenge that automatically fails with a custom error message.";
const getChallenge = async ({ challengeSettings }) => {
    // add a custom error message to display to the author
    const error = challengeSettings?.options?.error;
    // the only way to succeed the 'fail' challenge is to be excluded
    return {
        success: false,
        error: error || `You're not allowed to publish.`
    };
};
function ChallengeFileFactory({ challengeSettings }) {
    return { getChallenge, optionInputs, type, description };
}
export default ChallengeFileFactory;
//# sourceMappingURL=fail.js.map
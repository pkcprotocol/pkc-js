let callCount = 0;

export const getCallCount = () => callCount;
export const resetCallCount = () => {
    callCount = 0;
};

const getChallenge = async () => {
    callCount++;
    return { success: true };
};

const ChallengeFileFactory = () => ({ getChallenge, type: "text/plain" });

export default ChallengeFileFactory;

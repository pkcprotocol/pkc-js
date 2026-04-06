import type {
    ChallengeFileInput,
    ChallengeInput,
    ChallengeResultInput,
    GetChallengeArgsInput,
    SubplebbitChallengeSetting
} from "../../../../../community/types.js";

const optionInputs = <NonNullable<ChallengeFileInput["optionInputs"]>>[
    {
        option: "difficulty",
        label: "Difficulty",
        default: "1",
        description: "The math difficulty of the challenge between 1-3.",
        placeholder: "1"
    }
];

const type: ChallengeInput["type"] = "text/plain";

const description: ChallengeFileInput["description"] = "Ask a plain text math question, insecure, use ONLY for testing.";

const getRandomNumber = (minNumber: number, maxNumber: number) => Math.floor(Math.random() * (maxNumber - minNumber + 1) + minNumber);

const getChallengeString = (minNumber: number, maxNumber: number, operators: ("*" | "-" | "+" | "/")[]) => {
    let firstNumber = getRandomNumber(minNumber, maxNumber);
    let secondNumber = getRandomNumber(minNumber, maxNumber);
    const operator = operators[getRandomNumber(0, operators.length - 1)];
    // reduce multiply difficulty
    if (operator === "*") {
        firstNumber = Math.ceil(firstNumber / 10);
        secondNumber = Math.ceil(secondNumber / 10);
    }
    // don't allow negative numbers
    if (operator === "-" && firstNumber < secondNumber) {
        const _firstNumber = firstNumber;
        firstNumber = secondNumber;
        secondNumber = _firstNumber;
    }
    return `${firstNumber} ${operator} ${secondNumber}`;
};

const getChallenge = async ({ challengeSettings }: GetChallengeArgsInput): Promise<ChallengeInput> => {
    const difficultyString = challengeSettings?.options?.difficulty || "1";
    const difficulty = Number(difficultyString);

    let challenge: string;
    if (difficulty === 1) {
        challenge = getChallengeString(1, 10, ["+", "-"]);
    } else if (difficulty === 2) {
        challenge = getChallengeString(10, 100, ["+", "-", "*"]);
    } else if (difficulty === 3) {
        challenge = getChallengeString(100, 1000, ["+", "-", "*"]);
    } else {
        throw Error(`invalid challenge difficulty '${difficulty}'`);
    }

    const verify = async (_answer: string): Promise<ChallengeResultInput> => {
        if (String(eval(challenge)) === _answer) {
            return { success: true };
        }
        return {
            success: false,
            error: "Wrong answer."
        };
    };
    return { challenge, verify, type };
};

function ChallengeFileFactory({ challengeSettings }: { challengeSettings: SubplebbitChallengeSetting }): ChallengeFileInput {
    return { getChallenge, optionInputs, type, description };
}

export default ChallengeFileFactory;

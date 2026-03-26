import signers from "./signers.js";

const comment = {
    communityAddress: signers[0].address,
    author: { address: signers[1].address },
    timestamp: 1600000000,
    parentCid: "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGyx",
    postCid: "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGyx",
    content: "some content... "
};
// test large content
let i: number = 1000;
while (i--) {
    comment.content += "some content... ";
}

export { comment };

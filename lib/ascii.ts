import chalk from "chalk";

export const printLLAMIASCII = (text?: string) => {
  const asciiArt = `   /\\_/\\
  ( o.o ) Hi I'm LLAMI!
   > ^ <
`;

  // * 분홍색으로 출력 (Node.js 콘솔)
  console.log(chalk.magenta(asciiArt));

  // * 텍스트가 있으면 출력
  if (text) {
    console.log(text);
  }
};

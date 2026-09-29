import { createLLMProvider } from "../lib/llm";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("Testing LLM Provider: " + process.env.LLM_PROVIDER);
  try {
    const provider = createLLMProvider();
    const stream = provider.stream({
      messages: [{ role: "user", content: "안녕? 너는 누구니? 아주 짧게 대답해줘." }],
      maxTokens: 50
    });
    
    process.stdout.write("Response: ");
    for await (const token of stream) {
      process.stdout.write(token);
    }
    console.log("\n✅ Test successful!");
  } catch (err) {
    console.error("\n❌ Error:", err);
  }
}

main();

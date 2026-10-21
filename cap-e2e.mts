import { VtopClient } from "./src/services/vtop-client.js";
import fs from "node:fs";
async function main() {
  const c = new VtopClient();
  const img: string = await c.getCaptcha();
  fs.writeFileSync("/tmp/opencode/e2e-cap.jpg", Buffer.from(img.split(",")[1] ?? "", "base64"));
  console.log("WAITING for answer…");
  // wait for the human/agent to drop the characters in
  for (let i = 0; i < 120; i++) {
    if (fs.existsSync("/tmp/opencode/e2e-answer.txt")) {
      const answer = fs.readFileSync("/tmp/opencode/e2e-answer.txt", "utf8").trim();
      try {
        const r = await c.login(process.env.VTOP_USERNAME ?? "", process.env.VTOP_PASSWORD ?? "", answer);
        console.log("LOGIN OK:", JSON.stringify(r));
      } catch (e) {
        console.log("LOGIN FAILED:", e instanceof Error ? e.message.slice(0, 120) : e);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("TIMEOUT");
}
main();

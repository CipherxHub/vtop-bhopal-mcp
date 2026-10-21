import { VtopClient } from "./src/services/vtop-client.js";
import fs from "node:fs";
async function main() {
  const c = new VtopClient();
  const img: string = await c.getCaptcha();
  fs.writeFileSync("/tmp/opencode/diag-cap.jpg", Buffer.from(img.split(",")[1] ?? "", "base64"));
  console.log("WAITING…");
  for (let i = 0; i < 120; i++) {
    if (fs.existsSync("/tmp/opencode/diag-answer.txt")) {
      const answer = fs.readFileSync("/tmp/opencode/diag-answer.txt", "utf8").trim();
      // Raw POST so we can see VTOP's own words, not our classifier's.
      const form = new URLSearchParams();
      form.append("username", process.env.VTOP_USERNAME ?? "");
      form.append("password", process.env.VTOP_PASSWORD ?? "");
      form.append("captchaStr", answer);
      form.append("gResponse", answer);
      if (c.csrfToken) form.append("_csrf", c.csrfToken);
      const res = await c.loginClient().post("/login", form, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      const html: string = res.data;
      fs.writeFileSync("/tmp/opencode/login-response.html", html);
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      console.log("PAGE TEXT:", text.slice(0, 700));
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("TIMEOUT");
}
main();

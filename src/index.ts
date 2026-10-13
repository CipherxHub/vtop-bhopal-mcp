import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startKeepalive } from "./services/keepalive.js";

async function main() {
  const { server, client } = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  // VTOP idles a session out after ~20 minutes of inactivity, so keep touching
  // it. No-ops until a session exists.
  startKeepalive(client);
  console.error("VtopMCP server started on stdio transport");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

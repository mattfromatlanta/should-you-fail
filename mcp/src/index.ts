import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerLinkTools } from "./tools/links.js";
import { registerAuditTools } from "./tools/audit.js";
import { registerNameTools } from "./tools/names.js";

const server = new McpServer({
  name: "syf-campaign-mcp",
  version: "0.1.0",
});

registerReadTools(server);
registerWriteTools(server);
registerLinkTools(server);
registerAuditTools(server);
registerNameTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";

import { NAME_RULES_DIR } from "../paths.js";
import { generateOneName, loadNameRules } from "../names.js";

export function registerNameTools(server: McpServer): void {
  server.tool(
    "generate_name",
    "Generate names for a given category. Available categories: 'estaran', 'mortal'. Rules loaded from mcp/name-rules/{category}.yaml.",
    {
      category: z.string().describe("Name category. Available: 'estaran' (Estaran race names), 'mortal' (mortal/human names). Must match a file in mcp/name-rules/."),
      count: z.number().int().min(1).max(50).optional().describe("Number of names to generate (default 20, max 50)"),
    },
    async ({ category, count = 20 }) => {
      const rules = loadNameRules(category);
      if (!rules) {
        const available = fs.existsSync(NAME_RULES_DIR)
          ? fs.readdirSync(NAME_RULES_DIR).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(".yaml", ""))
          : [];
        return {
          content: [{ type: "text", text: `No rules found for '${category}'. Available: ${available.join(", ") || "none"}` }],
          isError: true,
        };
      }

      const approvedSet = new Set((rules.approved ?? []).map((n) => n.toLowerCase()));
      const names = new Set<string>();
      let attempts = 0;
      while (names.size < count && attempts < count * 20) {
        const name = generateOneName(rules);
        if (name && !approvedSet.has(name.toLowerCase())) names.add(name);
        attempts++;
      }

      const result: Record<string, unknown> = { category, description: rules.description };
      if (rules.approved?.length) result.approved = rules.approved;
      result.new = [...names];

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "cypriot-competition-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Shared _meta block -------------------------------------------------------

function buildMeta() {
  return {
    disclaimer:
      "This data is sourced from official CPC-CY publications and is provided for research purposes only. Verify all references against primary sources before making compliance decisions.",
    data_age: "Database updated periodically; may lag official publications.",
    copyright:
      "Data sourced from Commission for the Protection of Competition (CPC-CY). Original publications © Republic of Cyprus.",
    source_url: "https://www.competition.gov.cy/",
  };
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "cy_comp_search_decisions",
    description:
      "Full-text search across CPC-CY (Commission for the Protection of Competition — Cyprus) enforcement decisions covering abuse of dominance, cartel enforcement, and sector inquiries under Cypriot competition law (Law 13(I)/2022). Returns matching decisions with case number, parties, outcome, fine amount, and legal articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'abuse of dominance', 'price fixing', 'market concentration')" },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"],
          description: "Filter by decision type. Optional.",
        },
        sector: { type: "string", description: "Filter by sector ID (e.g., 'banking', 'telecommunications', 'energy'). Optional." },
        outcome: {
          type: "string",
          enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"],
          description: "Filter by outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "cy_comp_get_decision",
    description:
      "Get a specific CPC-CY decision by case number (e.g., '27/2023', '18/2022').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: { type: "string", description: "CPC-CY case number (e.g., '27/2023', '18/2022')" },
      },
      required: ["case_number"],
    },
  },
  {
    name: "cy_comp_search_mergers",
    description:
      "Search CPC-CY merger control decisions. Returns merger cases with acquiring party, target, sector, and outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'banking sector merger', 'telecom acquisition', 'retail concentration')" },
        sector: { type: "string", description: "Filter by sector ID. Optional." },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "cy_comp_get_merger",
    description:
      "Get a specific CPC-CY merger control decision by case number (e.g., 'M-12/2023').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: { type: "string", description: "CPC-CY merger case number (e.g., 'M-12/2023')" },
      },
      required: ["case_number"],
    },
  },
  {
    name: "cy_comp_list_sectors",
    description:
      "List all sectors with CPC-CY enforcement activity, including decision counts and merger counts per sector.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "cy_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "cy_comp_list_sources",
    description:
      "List all data sources used by this server with provenance metadata: name, URL, last ingestion date, scope, and limitations.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "cy_comp_check_data_freshness",
    description:
      "Check data freshness for each source. Reports staleness and when data was last updated.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "merger", "sector_inquiry"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["prohibited", "cleared", "cleared_with_conditions", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  case_number: z.string().min(1),
});

const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetMergerArgs = z.object({
  case_number: z.string().min(1),
});

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "cy_comp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            sector: parsed.sector,
            outcome: parsed.outcome,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length, _meta: buildMeta() });
        }

        case "cy_comp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.case_number);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.case_number}`);
          }
          return textContent({ ...decision, _meta: buildMeta() });
        }

        case "cy_comp_search_mergers": {
          const parsed = SearchMergersArgs.parse(args);
          const results = searchMergers({
            query: parsed.query,
            sector: parsed.sector,
            outcome: parsed.outcome,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length, _meta: buildMeta() });
        }

        case "cy_comp_get_merger": {
          const parsed = GetMergerArgs.parse(args);
          const merger = getMerger(parsed.case_number);
          if (!merger) {
            return errorContent(`Merger case not found: ${parsed.case_number}`);
          }
          return textContent({ ...merger, _meta: buildMeta() });
        }

        case "cy_comp_list_sectors": {
          const sectors = listSectors();
          return textContent({ sectors, count: sectors.length, _meta: buildMeta() });
        }

        case "cy_comp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "CPC-CY (Commission for the Protection of Competition — Cyprus) MCP server. Provides access to Cypriot competition law enforcement decisions, merger control cases, and sector enforcement data under Law 13(I)/2022.",
            data_source: "CPC-CY (https://www.competition.gov.cy/)",
            coverage: {
              decisions: "Abuse of dominance, cartel enforcement, and sector inquiries under Cypriot competition law",
              mergers: "Merger control decisions — Phase I and Phase II",
              sectors: "Banking, telecommunications, energy, retail, tourism, construction, media",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
            _meta: buildMeta(),
          });
        }

        case "cy_comp_list_sources": {
          return textContent({
            sources: [
              {
                name: "Commission for the Protection of Competition (CPC-CY)",
                url: "https://www.competition.gov.cy/",
                scope: "Enforcement decisions (abuse of dominance, cartels, sector inquiries) and merger control cases under Cypriot competition law (Law 13(I)/2022)",
                jurisdiction: "Cyprus (CY)",
                language: "Greek / English",
                license: "Public domain — official government publications",
                limitations: "Coverage may be incomplete; decisions predating digital publication may be missing",
              },
            ],
            _meta: buildMeta(),
          });
        }

        case "cy_comp_check_data_freshness": {
          return textContent({
            sources: [
              {
                name: "CPC-CY decisions",
                status: "periodic",
                note: "Database is updated periodically via the ingest-cpcc crawler. Check last_ingested field in coverage.json for exact timestamp.",
                staleness_warning: "Data may lag official CPC-CY publications by days to weeks.",
              },
            ],
            recommendation: "Run `npm run ingest` to refresh data from CPC-CY official website.",
            _meta: buildMeta(),
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

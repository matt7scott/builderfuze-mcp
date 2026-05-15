import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  matchBuilders,
  getBuilder,
  type PublicProfile,
  type MatchResult,
} from "../builderfuze-client.js";

/**
 * Tool definitions.
 *
 * Each tool's `description` is what Claude reads to decide when to use it.
 * Write these like job postings — clear, specific, accurate about when to
 * use this vs not.
 */
const toolDefs = [
  {
    name: "find_collaborators",
    description:
      "Find builders on BuilderFuze who would be a great fit for the project the user is currently working on. " +
      "Synthesize the conversation context into a rich description (tech stack, stage, what's missing, " +
      "domain, working style) and pass it as `description`. Returns top matches with reasoning. " +
      "Use this when the user is mid-flow on building something and explicitly asks for help, co-founders, or teammates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        description: {
          type: "string",
          description:
            "Rich synthesized description of the project + the specific gap to fill. " +
            "Include: tech stack, stage, what they're trying to build, what kind of person " +
            "they need, working style preferences.",
        },
        limit: {
          type: "number",
          default: 3,
          maximum: 10,
          description: "Number of matches to return. Default 3.",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "search_builders",
    description:
      "Search BuilderFuze's builder directory by free-text query. " +
      "Use this for exploratory searches (e.g. 'show me ML engineers in NYC'). " +
      "For project-specific matching, prefer `find_collaborators`.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Free-text search query" },
        limit: { type: "number", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_builder",
    description:
      "Fetch the full public profile of a specific builder by ID. " +
      "Use this when the user wants to dig into one specific person from prior search results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        builder_id: {
          type: "string",
          description: "The builder's BuilderFuze profile ID (UUID)",
        },
      },
      required: ["builder_id"],
    },
  },
] as const;

export function registerTools(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefs.map((t) => ({ ...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
      switch (name) {
        case "find_collaborators": {
          const desc = String(args?.description ?? "").trim();
          const limit = Math.min(Number(args?.limit ?? 3), 10);
          if (!desc) return errorOut("description is required");

          const result = await matchBuilders(desc);
          const top = result.matches.slice(0, limit);

          if (top.length === 0) {
            return ok(
              `No builders matched yet. BuilderFuze is still growing its pool — try a less specific description, or check back as more builders sign up.`
            );
          }

          return ok(
            `${result.interpreted_intent}\n\n` +
              top.map((m, i) => formatMatch(m, i + 1)).join("\n\n")
          );
        }

        case "search_builders": {
          const query = String(args?.query ?? "").trim();
          const limit = Math.min(Number(args?.limit ?? 10), 20);
          if (!query) return errorOut("query is required");

          const result = await matchBuilders(query);
          const top = result.matches.slice(0, limit);

          if (top.length === 0) {
            return ok(`No builders matched "${query}".`);
          }

          return ok(
            `${result.interpreted_intent}\n\n` +
              top
                .map(
                  (m) =>
                    `**${m.profile.display_name}** — ${m.profile.headline ?? ""}\n` +
                    `Looking for: ${m.profile.looking_for_role ?? "—"}\n` +
                    `https://builderfuze.vercel.app/profile/${m.profile.id}`
                )
                .join("\n\n")
          );
        }

        case "get_builder": {
          const id = String(args?.builder_id ?? "").trim();
          if (!id) return errorOut("builder_id is required");

          const profile = await getBuilder(id);
          return ok(formatProfileDeep(profile));
        }

        default:
          return errorOut(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return errorOut(
        err instanceof Error ? err.message : "Unexpected tool error"
      );
    }
  });
}

function formatMatch(m: MatchResult, rank: number): string {
  const p = m.profile;
  const skills = p.skills
    .slice(0, 5)
    .map((s) => s.name)
    .join(", ");
  const projects =
    m.public_projects && m.public_projects.length > 0
      ? `\n   🚀 Building: ${m.public_projects
          .slice(0, 2)
          .map((p) => p.name)
          .join(", ")}`
      : "";
  return (
    `${rank}. **${p.display_name}** — ${p.headline ?? ""}\n` +
    `   📍 ${p.location ?? "—"}\n` +
    `   🎯 Looking for: ${p.looking_for_role ?? "—"}\n` +
    `   🛠  Skills: ${skills || "—"}${projects}\n` +
    `   📊 Match: ${m.score}% · ${m.reasoning}\n` +
    `   🔗 https://builderfuze.vercel.app/profile/${p.id}`
  );
}

function formatProfileDeep(p: PublicProfile): string {
  const skills = p.skills.map((s) => s.name).join(", ");
  const industries = p.industries.map((i) => i.name).join(", ");
  return (
    `# ${p.display_name}\n\n` +
    `**${p.headline ?? ""}**\n\n` +
    (p.about_me ? `${p.about_me}\n\n` : "") +
    `**Looking for:** ${p.looking_for_role || "—"}\n` +
    `**Location:** ${p.location || "—"}\n` +
    (skills ? `**Skills:** ${skills}\n` : "") +
    (industries ? `**Industries:** ${industries}\n` : "") +
    (p.github_url ? `**GitHub:** ${p.github_url}\n` : "") +
    (p.linkedin_url ? `**LinkedIn:** ${p.linkedin_url}\n` : "") +
    (p.portfolio_url ? `**Portfolio:** ${p.portfolio_url}\n` : "") +
    `\nProfile: https://builderfuze.vercel.app/profile/${p.id}`
  );
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorOut(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

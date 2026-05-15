import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  matchBuilders,
  getBuilder,
  getInbox,
  sendConnectionRequest,
  type PublicProfile,
  type MatchResult,
} from "../builderfuze-client.js";
import type { AccessTokenClaims } from "../auth/tokens.js";

/** Session is undefined when running stdio (Claude Desktop dev) — anonymous BF calls. */
export type ToolSession = AccessTokenClaims | undefined;

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
  {
    name: "send_connection_request",
    description:
      "Send a connection request to a builder on BuilderFuze, on behalf of the authenticated user. " +
      "Use this after the user explicitly indicates they want to reach out to someone (e.g., 'send a request to Sarah'). " +
      "An optional message is supported but only for Pro-tier users — for free users, the request is sent " +
      "without a message. If the user wants to attach a project context, pass project_context_id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        builder_id: {
          type: "string",
          description: "The recipient builder's BuilderFuze profile ID (UUID)",
        },
        message: {
          type: "string",
          description:
            "Optional personalized message (Pro feature; will be ignored for free users)",
        },
        project_context_id: {
          type: "string",
          description: "Optional ID of the project this connection is about",
        },
      },
      required: ["builder_id"],
    },
  },
  {
    name: "get_my_inbox",
    description:
      "Return the authenticated user's BuilderFuze inbox: pending incoming/outgoing connection requests, " +
      "recent conversations with unread state, and unread counts. " +
      "Use this when the user asks things like 'what's in my inbox', 'any new requests', 'who's waiting on me'.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
] as const;

export function registerTools(server: Server, session?: ToolSession) {
  const bfToken = session?.bf_access_token;

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

          const result = await matchBuilders(desc, bfToken);
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

          const result = await matchBuilders(query, bfToken);
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

          const profile = await getBuilder(id, bfToken);
          return ok(formatProfileDeep(profile));
        }

        case "send_connection_request": {
          if (!bfToken) {
            return errorOut(
              "You need to be signed in to BuilderFuze (via the Claude connector OAuth flow) to send connection requests."
            );
          }
          const id = String(args?.builder_id ?? "").trim();
          if (!id) return errorOut("builder_id is required");
          const message =
            typeof args?.message === "string" ? args.message.trim() : undefined;
          const projectCtx =
            typeof args?.project_context_id === "string"
              ? args.project_context_id.trim()
              : undefined;
          try {
            const r = await sendConnectionRequest(
              id,
              { message: message || undefined, project_context_id: projectCtx },
              bfToken
            );
            return ok(
              `Connection request sent. The builder will see it in their BuilderFuze inbox.\n\n` +
                `Request ID: ${r.connection.id}\n` +
                `Status: ${r.connection.status}`
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Could not send.";
            return errorOut(msg);
          }
        }

        case "get_my_inbox": {
          if (!bfToken) {
            return errorOut(
              "You need to be signed in to BuilderFuze (via the Claude connector OAuth flow) to view your inbox."
            );
          }
          const inbox = await getInbox(bfToken);
          return ok(formatInbox(inbox));
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

import type { InboxResponse } from "../builderfuze-client.js";

function formatInbox(inbox: InboxResponse): string {
  const c = inbox.counts;
  const parts: string[] = [];

  parts.push(
    `📥 Inbox · ${c.pending_connection_requests} pending request(s) · ${c.unread_messages} unread message(s) · ${c.unread_notifications} unread notification(s)`
  );

  if (inbox.pending_in.length > 0) {
    parts.push(
      "\n## Incoming requests\n" +
        inbox.pending_in
          .map(
            (r) =>
              `• **${r.requester.display_name}** (${r.requester.looking_for_role ?? "—"})\n` +
              `  ${r.requester.headline ?? ""}\n` +
              (r.message ? `  Note: "${r.message}"\n` : "") +
              `  Sent ${timeAgo(r.created_at)} · accept at builderfuze.vercel.app/connections`
          )
          .join("\n")
    );
  }

  if (inbox.conversations.length > 0) {
    parts.push(
      "\n## Recent conversations\n" +
        inbox.conversations
          .map(
            (c) =>
              `• ${c.unread ? "🔴 " : ""}**${c.other.display_name}**: ${c.last_message_preview ?? "Say hi 👋"}`
          )
          .join("\n")
    );
  }

  if (inbox.pending_out.length > 0) {
    parts.push(
      `\n## Sent requests still pending\n` +
        inbox.pending_out
          .map(
            (r) =>
              `• ${r.recipient.display_name} · sent ${timeAgo(r.created_at)}`
          )
          .join("\n")
    );
  }

  if (
    inbox.pending_in.length === 0 &&
    inbox.conversations.length === 0 &&
    inbox.pending_out.length === 0
  ) {
    parts.push("\nYour inbox is quiet. Try `find_collaborators` to start reaching out.");
  }

  return parts.join("\n");
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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

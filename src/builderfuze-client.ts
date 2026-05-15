/**
 * Thin client around BuilderFuze's existing Next.js API.
 *
 * The MCP server never talks to Supabase directly — it always goes through
 * BuilderFuze's API. That way:
 *   - Algorithm changes happen inside BuilderFuze; MCP picks them up free
 *   - RLS + tier gating stays enforced in one place
 *   - The API contract is the only stable surface we depend on
 */

const BF_BASE =
  process.env.BUILDERFUZE_API_URL ?? "https://builderfuze.vercel.app";

export interface PublicProfile {
  id: string;
  display_name: string;
  headline: string;
  about_me: string;
  location: string;
  looking_for_role: string;
  github_url: string | null;
  linkedin_url: string | null;
  portfolio_url: string | null;
  avatar_url: string | null;
  skills: Array<{ id: string; name: string; category?: string | null }>;
  industries: Array<{ id: string; name: string }>;
}

export interface MatchResult {
  profile: PublicProfile;
  score: number;
  reasoning: string;
  public_projects?: Array<{ id: string; name: string }>;
}

export interface MatchResponse {
  interpreted_intent: string;
  matches: MatchResult[];
}

interface BfFetchOpts {
  method?: "GET" | "POST";
  body?: unknown;
  bearerToken?: string;
}

async function bfFetch<T>(path: string, opts: BfFetchOpts = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.bearerToken) {
    headers["Authorization"] = `Bearer ${opts.bearerToken}`;
  }

  const res = await fetch(`${BF_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `BuilderFuze API ${res.status} at ${path}: ${text.slice(0, 200)}`
    );
  }
  return (await res.json()) as T;
}

/**
 * Search builders by free-text description. Powers `find_collaborators` and
 * `search_builders` MCP tools. Returns BuilderFuze's current match algorithm
 * output — when cousin's algorithm replaces internals, this response shape
 * stays the same and MCP automatically benefits.
 */
export async function matchBuilders(
  query: string,
  bearerToken?: string
): Promise<MatchResponse> {
  return bfFetch<MatchResponse>("/api/match", {
    method: "POST",
    body: { query },
    bearerToken,
  });
}

/**
 * Fetch a single builder's full public profile.
 */
export async function getBuilder(
  id: string,
  bearerToken?: string
): Promise<PublicProfile> {
  // Public profile fetch — uses the existing profiles endpoint.
  // (We hit Supabase via the API to keep RLS in play.)
  const r = await bfFetch<{ profile: PublicProfile }>(
    `/api/profiles/${encodeURIComponent(id)}`,
    { bearerToken }
  );
  return r.profile;
}

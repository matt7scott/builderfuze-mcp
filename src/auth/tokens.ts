/**
 * JWT issuance + verification for MCP access tokens.
 *
 * An MCP access token is OUR token (signed by our JWT_SECRET) that wraps
 * the user's BuilderFuze identity. Inside the JWT:
 *   - user_id: their BuilderFuze profile ID
 *   - bf_access_token: the user's Supabase JWT (used to call BF API as them)
 *   - bf_refresh_token: optional, for refresh
 *   - tier: free | pro (cached for quick checks)
 */

import * as jose from "jose";

const SECRET = (() => {
  const raw = process.env.JWT_SECRET;
  if (!raw) {
    throw new Error(
      "JWT_SECRET env var is required (must be at least 32 random bytes)"
    );
  }
  return new TextEncoder().encode(raw);
})();

export interface AccessTokenClaims {
  user_id: string;
  bf_access_token: string;
  bf_refresh_token?: string;
  tier: "free" | "pro";
}

export async function issueAccessToken(
  claims: AccessTokenClaims,
  expiresInSeconds = 3600
): Promise<{ access_token: string; expires_in: number }> {
  const access_token = await new jose.SignJWT({
    ...claims,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .setSubject(claims.user_id)
    .sign(SECRET);

  return { access_token, expires_in: expiresInSeconds };
}

export async function verifyAccessToken(
  token: string
): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jose.jwtVerify(token, SECRET);
    if (typeof payload.user_id !== "string") return null;
    if (typeof payload.bf_access_token !== "string") return null;
    return {
      user_id: payload.user_id,
      bf_access_token: payload.bf_access_token,
      bf_refresh_token:
        typeof payload.bf_refresh_token === "string"
          ? payload.bf_refresh_token
          : undefined,
      tier: payload.tier === "pro" ? "pro" : "free",
    };
  } catch {
    return null;
  }
}

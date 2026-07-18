/**
 * Auth0 native-app login (RFC §6).
 *
 * Correct pattern, implemented deliberately:
 *  - Auth0 application type: NATIVE (not SPA, not M2M).
 *  - Login opens the SYSTEM BROWSER (shell.openExternal) with Authorization
 *    Code Flow + PKCE. An embedded BrowserWindow login form is explicitly the
 *    WRONG pattern (insecure, violates OAuth native-app guidance) and is not
 *    used anywhere here.
 *  - The callback returns via the custom URI scheme museic://callback.
 *  - Tokens are stored with Electron safeStorage (OS keychain-backed
 *    encryption), never plaintext / localStorage.
 *  - The `sub` claim of the resulting JWT is the user_id everywhere.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { app, safeStorage, shell } from "electron";

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN ?? "";
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID ?? "";
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE ?? "";
const REDIRECT_URI = "museic://callback";

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at: number; // epoch ms
}

let pending: { verifier: string; state: string } | null = null;
let cached: StoredTokens | null = null;

function tokenFile(): string {
  return path.join(app.getPath("userData"), "tokens.bin");
}

function saveTokens(tokens: StoredTokens): void {
  cached = tokens;
  const plaintext = JSON.stringify(tokens);
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(tokenFile(), safeStorage.encryptString(plaintext));
  } else {
    // Should not happen on Windows/macOS; refuse to persist unencrypted.
    console.warn("safeStorage unavailable; tokens held in memory only");
  }
}

function loadTokens(): StoredTokens | null {
  if (cached) return cached;
  try {
    const blob = fs.readFileSync(tokenFile());
    if (!safeStorage.isEncryptionAvailable()) return null;
    cached = JSON.parse(safeStorage.decryptString(blob)) as StoredTokens;
    return cached;
  } catch {
    return null;
  }
}

export function logout(): void {
  cached = null;
  try {
    fs.rmSync(tokenFile(), { force: true });
  } catch {
    /* ignore */
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Open the system browser on the Auth0 /authorize endpoint (PKCE). */
export function beginLogin(): void {
  if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID) {
    throw new Error("AUTH0_DOMAIN / AUTH0_CLIENT_ID not configured (repo-root .env)");
  }
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  pending = { verifier, state };

  const params = new URLSearchParams({
    client_id: AUTH0_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    audience: AUTH0_AUDIENCE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  void shell.openExternal(`https://${AUTH0_DOMAIN}/authorize?${params.toString()}`);
}

/** Handle museic://callback?code=...&state=... from the OS. */
export async function handleCallbackUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "museic:") return false;
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  const authError = parsed.searchParams.get("error");
  const authErrorDesc = parsed.searchParams.get("error_description");
  if (authError) {
    console.error("auth callback: Auth0 returned an error instead of a code:", {
      error: authError,
      error_description: authErrorDesc,
    });
    return false;
  }
  if (!code) {
    console.warn("auth callback rejected: no `code` param in callback URL", url);
    return false;
  }
  if (!pending) {
    console.warn("auth callback rejected: no pending login in this process (was beginLogin() called on a different app instance?)");
    return false;
  }
  if (state !== pending.state) {
    console.warn("auth callback rejected: state mismatch", {
      received: state,
      expected: pending.state,
    });
    return false;
  }
  const resp = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: AUTH0_CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
    }),
  });
  pending = null;
  if (!resp.ok) {
    console.error("token exchange failed:", resp.status, await resp.text());
    return false;
  }
  const body = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };
  saveTokens({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    id_token: body.id_token,
    expires_at: Date.now() + body.expires_in * 1000,
  });
  return true;
}

async function refresh(tokens: StoredTokens): Promise<StoredTokens | null> {
  if (!tokens.refresh_token) return null;
  const resp = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: AUTH0_CLIENT_ID,
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!resp.ok) return null;
  const body = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };
  const updated: StoredTokens = {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? tokens.refresh_token,
    id_token: body.id_token ?? tokens.id_token,
    expires_at: Date.now() + body.expires_in * 1000,
  };
  saveTokens(updated);
  return updated;
}

/** Valid access token, refreshing if within a minute of expiry. */
export async function getAccessToken(): Promise<string | null> {
  let tokens = loadTokens();
  if (!tokens) return null;
  if (Date.now() > tokens.expires_at - 60_000) {
    const refreshed = await refresh(tokens);
    if (!refreshed) {
      logout();
      return null;
    }
    tokens = refreshed;
  }
  return tokens.access_token;
}

/** Display-only claims from the id_token (sub, name, email). Not verified
 * here -- the backend independently validates every JWT it receives. */
export function getUserClaims(): { sub: string; name?: string; email?: string; picture?: string } | null {
  const tokens = loadTokens();
  if (!tokens?.id_token) return null;
  try {
    const payload = tokens.id_token.split(".")[1];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return { sub: claims.sub, name: claims.name, email: claims.email, picture: claims.picture };
  } catch {
    return null;
  }
}

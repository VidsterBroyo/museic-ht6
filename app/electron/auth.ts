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

// The Spotify federated connection (Auth0). Users pick their own login method;
// Spotify playlist export is authorized SEPARATELY via the Connected Accounts
// flow (see beginConnectSpotify), which stores the Spotify tokens in Auth0 Token
// Vault against the currently logged-in user (RFC §6).
const AUTH0_SPOTIFY_CONNECTION = process.env.AUTH0_SPOTIFY_CONNECTION ?? "spotify";
// Upstream Spotify OAuth scopes needed to create playlists on the user's behalf,
// requested during the Connected Accounts flow. The connection must also have
// Offline Access / Token Vault enabled so the refresh token is actually stored.
const SPOTIFY_CONNECTION_SCOPE = "playlist-modify-public playlist-modify-private";
// My Account API base -- the Connected Accounts endpoints live under here, and
// it is also the audience of the access token used to call them.
const MY_ACCOUNT_AUDIENCE = `https://${AUTH0_DOMAIN}/me/`;

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at: number; // epoch ms
}

let pending: { verifier: string; state: string } | null = null;
let pendingConnect: { verifier: string; authSession: string; myAccountToken: string } | null = null;
// Interactive My Account API authorize in progress (Connect Spotify fallback).
let pendingMyAccount: { verifier: string; state: string } | null = null;
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

/** Open the system browser on the Auth0 /authorize endpoint (PKCE). Users pick
 * their login method in Universal Login (Spotify appears there too if its
 * connection has Authentication enabled). */
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

export type CallbackResult = "login" | "connect" | "ignored";

/**
 * Handle museic://callback from the OS. Two shapes are accepted:
 *  - login:   ?code=...&state=...   (Authorization Code + PKCE)
 *  - connect: ?connect_code=...     (Connected Accounts / Token Vault)
 */
export async function handleCallbackUrl(url: string): Promise<CallbackResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "ignored";
  }
  if (parsed.protocol !== "museic:") return "ignored";
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  const connectCode = parsed.searchParams.get("connect_code");
  const authError = parsed.searchParams.get("error");
  const authErrorDesc = parsed.searchParams.get("error_description");
  if (authError) {
    console.error("auth callback: Auth0 returned an error instead of a code:", {
      error: authError,
      error_description: authErrorDesc,
    });
    pending = null;
    pendingConnect = null;
    return "ignored";
  }

  // Connected Accounts (Connect Spotify) completion.
  if (connectCode) {
    return (await completeConnectSpotify(connectCode)) ? "connect" : "ignored";
  }

  // Interactive My Account API token step of the Connect Spotify flow. This is
  // the fallback used when the silent refresh-token exchange can't satisfy the
  // API's authentication-assurance requirement. On success we immediately kick
  // off the actual connect (opening the Spotify consent URI); the final result
  // arrives later as a `connect_code` callback, handled above.
  if (code && pendingMyAccount && state === pendingMyAccount.state) {
    const verifier = pendingMyAccount.verifier;
    pendingMyAccount = null;
    const tokenResp = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: AUTH0_CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    if (!tokenResp.ok) {
      console.error(
        "My Account token exchange (interactive) failed:",
        tokenResp.status,
        await tokenResp.text(),
      );
      return "ignored";
    }
    const myAccountToken = ((await tokenResp.json()) as { access_token: string }).access_token;
    try {
      await requestConnect(myAccountToken);
    } catch (e) {
      console.error("connected-accounts/connect failed after interactive token:", e);
    }
    return "ignored";
  }

  // Standard login.
  if (!code) {
    console.warn("auth callback rejected: no `code`/`connect_code` param in callback URL", url);
    return "ignored";
  }
  if (!pending) {
    console.warn("auth callback rejected: no pending login in this process (was beginLogin() called on a different app instance?)");
    return "ignored";
  }
  if (state !== pending.state) {
    console.warn("auth callback rejected: state mismatch", {
      received: state,
      expected: pending.state,
    });
    return "ignored";
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
    return "ignored";
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
  return "login";
}

// ---------------------------------------------------------------------------
// Connect Spotify (Auth0 Connected Accounts for Token Vault)
//
// Attaches the user's Spotify account to their EXISTING Auth0 profile so the
// backend can exchange the logged-in user's token for a Spotify token at export
// time. Deliberately separate from login: users authenticate with any
// connection, then authorize Spotify once here.
// ---------------------------------------------------------------------------

/** Get a My Account API access token via a refresh-token exchange. Requires
 * Multi-Resource Refresh Token enabled for the app. Returns null on failure. */
async function getMyAccountToken(): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) return null;
  const resp = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: AUTH0_CLIENT_ID,
      refresh_token: tokens.refresh_token,
      audience: MY_ACCOUNT_AUDIENCE,
      scope: "openid create:me:connected_accounts",
    }),
  });
  if (!resp.ok) {
    console.error("My Account API token exchange failed:", resp.status, await resp.text());
    return null;
  }
  return ((await resp.json()) as { access_token: string }).access_token;
}

/** Start the Connect Spotify flow by acquiring a My Account API token via an
 * interactive browser authorize, so the subsequent Connected Accounts connect
 * page runs inside an authenticated Auth0 browser session. Completion arrives
 * via museic://callback (My Account code -> connect URI -> connect_code). */
export async function beginConnectSpotify(): Promise<void> {
  if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID) {
    throw new Error("AUTH0_DOMAIN / AUTH0_CLIENT_ID not configured (repo-root .env)");
  }
  // The Connected Accounts connect page runs in the system browser and must run
  // inside a fresh, authenticated Auth0 session. Obtaining the My Account token
  // silently (refresh-token exchange in this process) leaves the browser without
  // that session, so Auth0 rejects the connect page with "forbidden". Always
  // acquire the token interactively; handleCallbackUrl then opens the connect URI
  // in that same authenticated browser.
  console.log("[connect] starting interactive My Account authorize");
  beginMyAccountAuthorize();
}

/** Interactive acquisition of a My Account API access token via Universal Login,
 * used when the silent refresh-token exchange can't satisfy the API's
 * authentication-assurance requirement. Continues in handleCallbackUrl. */
function beginMyAccountAuthorize(): void {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  pendingMyAccount = { verifier, state };
  const params = new URLSearchParams({
    client_id: AUTH0_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "openid create:me:connected_accounts",
    audience: MY_ACCOUNT_AUDIENCE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  const authorizeUrl = `https://${AUTH0_DOMAIN}/authorize?${params.toString()}`;
  console.log("[connect] interactive My Account authorize URL:", authorizeUrl);
  void shell.openExternal(authorizeUrl);
}

/** Ask the My Account API for a connect URI (using the given My Account token)
 * and open it in the system browser. Completion arrives via museic://callback
 * with a `connect_code`. Throws with an actionable message on failure. */
async function requestConnect(myAccountToken: string): Promise<void> {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const resp = await fetch(`${MY_ACCOUNT_AUDIENCE}v1/connected-accounts/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${myAccountToken}`,
    },
    body: JSON.stringify({
      connection: AUTH0_SPOTIFY_CONNECTION,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scopes: ["openid", "offline_access", ...SPOTIFY_CONNECTION_SCOPE.split(" ")],
    }),
  });
  console.log("[connect] connect POST status:", resp.status);
  if (!resp.ok) {
    throw new Error(
      `Auth0 connected-accounts/connect failed: ${resp.status} ${(await resp.text()).slice(0, 300)}`,
    );
  }
  const body = (await resp.json()) as {
    connect_uri?: string;
    auth_session?: string;
    ticket?: string;
    connect_params?: { ticket?: string };
  };
  console.log("[connect] connect response body:", JSON.stringify(body));
  // Auth0 returns a base connect_uri plus a ticket; the interactive page needs
  // the ticket as a query param, otherwise it 400s with a generic
  // "one or more validation errors occurred".
  const ticket = body.ticket ?? body.connect_params?.ticket;
  if (!body.connect_uri || !body.auth_session || !ticket) {
    throw new Error(
      "Auth0 connected-accounts/connect returned an unexpected response (missing connect_uri/auth_session/ticket).",
    );
  }
  const connectUrl = new URL(body.connect_uri);
  connectUrl.searchParams.set("ticket", ticket);
  pendingConnect = { verifier, authSession: body.auth_session, myAccountToken };
  void shell.openExternal(connectUrl.toString());
}

/** Finish the Connect Spotify flow with the connect_code from the callback. */
async function completeConnectSpotify(connectCode: string): Promise<boolean> {
  if (!pendingConnect) {
    console.warn("connect callback rejected: no pending Spotify connect in this process");
    return false;
  }
  const { verifier, authSession, myAccountToken } = pendingConnect;
  pendingConnect = null;
  const resp = await fetch(`${MY_ACCOUNT_AUDIENCE}v1/connected-accounts/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${myAccountToken}`,
    },
    body: JSON.stringify({
      connect_code: connectCode,
      code_verifier: verifier,
      auth_session: authSession,
    }),
  });
  if (!resp.ok) {
    console.error("connected-accounts/complete failed:", resp.status, await resp.text());
    return false;
  }
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

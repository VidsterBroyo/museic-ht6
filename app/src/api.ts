/** Backend client. Every request carries the Auth0 JWT (RFC §6). */
let backendUrl = "http://127.0.0.1:8000";

export async function initApi(): Promise<void> {
  const cfg = await window.museic.getConfig();
  backendUrl = cfg.backendUrl;
}

export function getBackendUrl(): string {
  return backendUrl;
}

async function token(): Promise<string> {
  const session = await window.museic.getSession();
  if (!session) throw new Error("not logged in");
  return session.accessToken;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const resp = await fetch(`${backendUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text.slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

/** Audio URL for an <audio> element -- token goes in the query string because
 * audio elements can't set headers (backend accepts both). */
export async function audioUrl(songId: string): Promise<string> {
  return `${backendUrl}/songs/${encodeURIComponent(songId)}/audio?token=${encodeURIComponent(await token())}`;
}

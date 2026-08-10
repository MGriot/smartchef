const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body === "object" && body && "error" in body
      ? JSON.stringify((body as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new Error(`SmartChef backend request failed (${path}): ${message}`);
  }
  return (body as { data?: T }).data ?? (body as T);
}

export const backend = {
  get: <T = unknown>(path: string) => request<T>(path),
  post: <T = unknown>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
};

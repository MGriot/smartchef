// Refuses to boot in production on the public dev-default secrets, which
// would let anyone forge session cookies and decrypt stored LLM keys.

const DEFAULTS: Record<string, string> = {
  SESSION_SECRET: "smartchef-dev-secret-change-me",
  LLM_KEY_ENCRYPTION_SECRET: "smartchef-dev-encryption-secret-change-me",
};

export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const bad = Object.entries(DEFAULTS)
    .filter(([name, dev]) => !env[name] || env[name] === dev)
    .map(([name]) => name);
  if (bad.length === 0) return;
  throw new Error(
    `Refusing to start in production with default/missing secrets: ${bad.join(", ")}. ` +
      `Set them to long random values (e.g. \`openssl rand -hex 32\`).`
  );
}

# Security policy

## Reporting a vulnerability
Please do not open a public issue. Email matteo.griot@gmail.com with steps to reproduce. Expect a reply within a week.

## Supported versions
Only the latest release receives security fixes.

## Deploying the server safely
- Set `SESSION_SECRET` and `LLM_KEY_ENCRYPTION_SECRET` to long random values (`openssl rand -hex 32`). The server refuses to start in production without them.
- Set `CORS_ORIGIN` to the exact origins that call the API, and `COOKIE_SECURE=true` once HTTPS is in front.
- Postgres and the MCP port are bound to localhost; keep them off public interfaces.
- Create the first account right after deploying: the API is open until one exists.
- Behind a reverse proxy, leave `TRUST_PROXY=1` so login rate limiting is per client.

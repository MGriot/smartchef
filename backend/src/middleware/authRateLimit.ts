// Brute-force throttle for credential-taking auth routes. Failed logins are
// what count (successes are skipped), so a household sharing one IP isn't
// locked out by normal use. Behind a reverse proxy set TRUST_PROXY=1, or
// every client appears to share the proxy's IP.

import rateLimit from "express-rate-limit";

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in a few minutes." },
});

// Account creation has no failure signal to key on, so every call counts.
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-ups from this address. Try again later." },
});

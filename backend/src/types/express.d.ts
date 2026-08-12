// Augments Express's Request with the identity requireAuth attaches after
// verifying the session JWT, so req.userId/req.userRole typecheck in every
// route file with no `as any` cast needed.
export {};

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: "admin" | "user";
    }
  }
}

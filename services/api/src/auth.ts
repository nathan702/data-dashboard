import type { NextFunction, Request, Response } from "express";

export interface Viewer {
  email: string;
  name: string | null;
  isAdmin: boolean;
}

export interface VerifiedToken {
  email?: string;
  email_verified?: boolean;
  name?: string;
  /** Hosted domain claim Google includes for Workspace accounts. */
  hd?: string;
}

export interface AccessList {
  /** When non-empty, only these emails may sign in (on top of the domain check). */
  allowedEmails: string[];
  admins: string[];
}

export interface AuthDeps {
  verifyIdToken(token: string): Promise<VerifiedToken>;
  loadAccessList(): Promise<AccessList>;
  allowedDomains: string[];
}

export type AccessDecision = { ok: true; viewer: Viewer } | { ok: false; reason: string };

/** Pure access decision so it can be tested without Firebase. */
export function decideAccess(token: VerifiedToken, access: AccessList, allowedDomains: string[]): AccessDecision {
  const email = token.email?.toLowerCase();
  if (!email || token.email_verified !== true) return { ok: false, reason: "A verified Google account is required" };
  const domain = email.split("@")[1] ?? "";
  // Require both the email domain and Google's hosted-domain claim, so a
  // personal Gmail account can't pass by using a lookalike address.
  if (!allowedDomains.includes(domain) || (token.hd ?? "").toLowerCase() !== domain) {
    return { ok: false, reason: "Sign in with your organization Google account" };
  }
  const allowed = access.allowedEmails.map((e) => e.toLowerCase());
  if (allowed.length > 0 && !allowed.includes(email)) {
    return { ok: false, reason: "Your account has not been given access yet" };
  }
  return {
    ok: true,
    viewer: {
      email,
      name: token.name ?? null,
      isAdmin: access.admins.map((e) => e.toLowerCase()).includes(email),
    },
  };
}

declare module "express-serve-static-core" {
  interface Request {
    viewer?: Viewer;
  }
}

export function requireViewer(deps: AuthDeps | null) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!deps) {
      req.viewer = { email: "dev@localhost", name: "Local developer", isAdmin: true };
      next();
      return;
    }
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    let decoded: VerifiedToken;
    try {
      decoded = await deps.verifyIdToken(token);
    } catch {
      res.status(401).json({ error: "Session expired, please sign in again" });
      return;
    }
    const decision = decideAccess(decoded, await deps.loadAccessList(), deps.allowedDomains);
    if (!decision.ok) {
      res.status(403).json({ error: decision.reason });
      return;
    }
    req.viewer = decision.viewer;
    next();
  };
}

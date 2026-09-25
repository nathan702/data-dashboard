import type { NextFunction, Request, Response } from "express";

export interface Viewer {
  email: string;
  name: string | null;
  isAdmin: boolean;
  /** True when no admin list is configured yet (so everyone is an admin). */
  adminsUnconfigured?: boolean;
}

export interface VerifiedToken {
  email?: string;
  email_verified?: boolean;
  name?: string;
  firebase?: { sign_in_provider?: string };
}

export interface AccessList {
  /** When non-empty, only these emails may sign in (on top of the domain check). */
  allowedEmails: string[];
  /** Who may change Settings. While empty, everyone who can sign in is an admin. */
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
  // Only Google sign-in counts: Google has verified the address, and an
  // @<workspace domain> Google account can only be issued by that Workspace.
  // (Firebase ID tokens don't carry Google's "hd" claim, so it can't be checked here.)
  if (token.firebase?.sign_in_provider !== "google.com") {
    return { ok: false, reason: "Sign in with Google" };
  }
  const domain = email.split("@")[1] ?? "";
  if (!allowedDomains.includes(domain)) {
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
      adminsUnconfigured: access.admins.length === 0,
      isAdmin: access.admins.length === 0 || access.admins.map((e) => e.toLowerCase()).includes(email),
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

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.viewer?.isAdmin) {
    res.status(403).json({ error: "Only dashboard admins can change this" });
    return;
  }
  next();
}

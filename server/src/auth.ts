import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db, nowIso, uid, audit } from './db.js';

export type Role = 'bureau_officer' | 'bureau_lead' | 'supervisor' | 'reviewer' | 'admin';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  bureau: string | null;
  region: string | null;
  grantedCaseIds: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

const SESSION_COOKIE = 'caselink_session';
const SESSION_HOURS = 8;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function loadGrants(userId: string): string[] {
  const rows = db
    .prepare('SELECT case_id FROM case_grants WHERE user_id = ? AND revoked_at IS NULL')
    .all(userId) as { case_id: string }[];
  return rows.map((r) => r.case_id);
}

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
    crypto.createHash('sha256').update(token).digest('hex'),
    userId,
    nowIso(),
    expires
  );
  return token;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setSessionCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${SESSION_HOURS * 3600}`
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`);
}

/** Reads a session token from the Authorization header first, then from the cookie. */
function sessionToken(req: Request): string | null {
  const auth = req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || null;
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

/**
 * Attaches req.user when a valid, unexpired session is presented.
 * The token may arrive as a cookie or as a Bearer token — preview iframes and strict browser
 * configurations can block cookies entirely, so both transports are supported and both are
 * verified against the same server-side session record.
 */
export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const token = sessionToken(req);
  if (!token) return next();
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db
    .prepare(
      `SELECT s.expires_at, u.id, u.username, u.display_name, u.role, u.bureau, u.region, u.active
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .get(hash) as
    | {
        expires_at: string;
        id: string;
        username: string;
        display_name: string;
        role: Role;
        bureau: string | null;
        region: string | null;
        active: number;
      }
    | undefined;
  if (!row) return next();
  if (new Date(row.expires_at).getTime() < Date.now() || row.active !== 1) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return next();
  }
  req.user = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    bureau: row.bureau,
    region: row.region,
    grantedCaseIds: loadGrants(row.id),
  };
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'authentication_required', message: 'Sign in to continue.' });
    return;
  }
  next();
}

/** Builds a session user from an account id (used by the demo auto-entry path). */
export function sessionUserById(userId: string): SessionUser | null {
  const row = db
    .prepare(
      `SELECT id, username, display_name, role, bureau, region, active FROM users WHERE id = ? AND active = 1`
    )
    .get(userId) as
    | { id: string; username: string; display_name: string; role: Role; bureau: string | null; region: string | null; active: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    bureau: row.bureau,
    region: row.region,
    grantedCaseIds: loadGrants(row.id),
  };
}

export function login(username: string, password: string): SessionUser | null {
  const row = db
    .prepare(
      `SELECT id, username, password_hash, display_name, role, bureau, region, active
         FROM users WHERE lower(username) = lower(?)`
    )
    .get(username) as
    | {
        id: string;
        username: string;
        password_hash: string;
        display_name: string;
        role: Role;
        bureau: string | null;
        region: string | null;
        active: number;
      }
    | undefined;
  if (!row || row.active !== 1 || !verifyPassword(password, row.password_hash)) {
    audit(row?.id ?? null, 'login_failed', `username=${username}`);
    return null;
  }
  audit(row.id, 'login_success', `role=${row.role}`);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    bureau: row.bureau,
    region: row.region,
    grantedCaseIds: loadGrants(row.id),
  };
}

export function logout(req: Request, res: Response): void {
  const token = sessionToken(req);
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(
      crypto.createHash('sha256').update(token).digest('hex')
    );
  }
  clearSessionCookie(res);
  audit(req.user?.id ?? null, 'logout', '');
}

export function purgeExpiredSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}

export function recordSecurityDenial(userId: string | undefined, detail: string): void {
  audit(userId ?? null, 'access_denied', detail);
  db.prepare('INSERT INTO security_log (id, at, actor_id, action, detail) VALUES (?,?,?,?,?)').run(
    uid(),
    nowIso(),
    userId ?? null,
    'access_denied_audit',
    detail
  );
}

import type { NextFunction, Request, Response } from 'express';

/** Reject cross-site browser mutations, including login/logout and multipart evidence uploads. */
export function sameOriginWrites(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.header('origin');
  let trusted = true;
  if (origin) {
    try {
      const parsed = new URL(origin);
      // Match the effective public host without trusting X-Forwarded-Host/Proto from a caller.
      // HTTP and HTTPS cover local development and TLS termination in front of this single-origin app.
      trusted = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin && parsed.host === req.get('host');
    } catch { trusted = false; }
  }
  if (req.header('sec-fetch-site') === 'cross-site' || !trusted) {
    res.status(403).json({ error: 'cross_site_request', message: 'Open CaseLink directly to make this change.' });
    return;
  }
  next();
}

const WINDOW_MS = 15 * 60_000;
const buckets = new Map<string, { failures: number; expires: number }>();

/** Single-instance prototype limiter. Only failed logins count; bounded memory and credential inputs. */
export function limitLogin(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  // Do not trust arbitrary forwarded IP headers; a proxy shares this conservative IP budget.
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 60) : '';
  const keys = [`ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`, `account:${username}`];
  for (const [key, bucket] of buckets) if (bucket.expires <= now) buckets.delete(key);
  const blocked = keys.map(key => buckets.get(key)).find((bucket, i) => bucket && bucket.failures >= (i === 0 ? 30 : 10));
  if (blocked || buckets.size >= 10_000) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(((blocked?.expires ?? now + WINDOW_MS) - now) / 1000))));
    res.status(429).json({ error: 'too_many_attempts', message: 'Too many failed sign-in attempts. Try again later.' });
    return;
  }
  res.once('finish', () => {
    if (res.statusCode !== 401) return;
    for (const key of keys) {
      const bucket = buckets.get(key) ?? { failures: 0, expires: now + WINDOW_MS };
      bucket.failures += 1;
      buckets.set(key, bucket);
    }
  });
  next();
}

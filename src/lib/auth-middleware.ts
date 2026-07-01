import type { MiddlewareHandler } from 'hono';
import { verifyGoogleIdToken } from './auth.ts';
import type { HonoEnv } from '../hono-env.ts';

/** Every protected route expects `Authorization: Bearer <google-id-token>`.
 *  Verified per-request rather than exchanged for a backend-issued JWT —
 *  Google id_tokens are short-lived (~1h) and the extension re-authenticates
 *  silently via launchWebAuthFlow, so there's no need to mint/manage our own. */
export const requireAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) return c.json({ error: 'Missing Authorization header' }, 401);

  try {
    const user = await verifyGoogleIdToken(token);
    c.set('user', user);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Unauthorized' }, 401);
  }

  await next();
};

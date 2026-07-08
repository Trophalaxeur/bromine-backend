import { Hono } from 'hono';
import { versionInfo } from '../lib/version.ts';

export const healthRoutes = new Hono();

healthRoutes.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));

// Unauthenticated like /health — lets the extension (and a curl from thallium) confirm exactly
// which build is deployed. versionInfo is resolved once at startup (see lib/version.ts).
healthRoutes.get('/version', (c) => c.json(versionInfo));

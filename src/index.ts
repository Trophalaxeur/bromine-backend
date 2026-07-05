import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.ts';
import { healthRoutes } from './routes/health.ts';
import { cvRoutes } from './routes/cv.ts';
import { pullContentRepos } from './lib/git.ts';
import type { HonoEnv } from './hono-env.ts';

const app = new Hono<HonoEnv>();

app.route('/', healthRoutes);
app.route('/', cvRoutes);

await pullContentRepos();

serve({ fetch: app.fetch, port: config.port, hostname: config.bindHost }, (info) => {
  console.log(`bromine-backend listening on ${config.bindHost ?? '*'}:${info.port} (${config.nodeEnv})`);
});

import { readFileSync, existsSync } from 'node:fs';

// Loads .env.<mode> manually (no dotenv dependency) — keeps dev/prod files
// explicit and out of the default process.env unless this ran.
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
loadEnvFile(nodeEnv === 'production' ? '.env.production' : '.env.development');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  nodeEnv,
  isDev: nodeEnv !== 'production',
  port: Number(process.env.PORT ?? 3000),

  useClaudeCli: nodeEnv !== 'production' && process.env.USE_CLAUDE_CLI !== 'false',
  anthropicApiKey: nodeEnv === 'production' || process.env.USE_CLAUDE_CLI === 'false' ? required('ANTHROPIC_API_KEY') : undefined,

  // Content repo paths: dev reads local checkouts directly, prod reads the
  // clones managed by the bromine-agent Ansible role (git pull on startup).
  carbonNotesPath: nodeEnv === 'production' ? required('CARBON_NOTES_REPO_PATH') : required('LOCAL_CARBON_NOTES'),
  bismuthBlogPath: nodeEnv === 'production' ? required('BISMUTH_BLOG_REPO_PATH') : required('LOCAL_BISMUTH_BLOG'),

  contentToken: process.env.CONTENT_TOKEN,

  googleClientId: required('GOOGLE_CLIENT_ID'),
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  allowedEmails: required('ALLOWED_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  adminEmail: process.env.BROMINE_ADMIN_EMAIL ?? 'admin@flefevre.fr',
} as const;

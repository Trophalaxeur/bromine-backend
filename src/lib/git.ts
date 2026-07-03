import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.ts';
import type { TailoredFile, Section } from './sessions.ts';
import type { CvBase } from './josiane.ts';

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr}`));
      else resolve();
    });
  });
}

export function tailoredDir(slug: string): string {
  return path.join(config.carbonNotesPath, 'cv', 'tailored', slug);
}

interface BriefInput {
  slug: string;
  name: string;
  base: string;
  locale: string;
  instructions: string;
}

function buildBrief(input: BriefInput): string {
  const date = new Date().toISOString().slice(0, 10);
  return `---
date: ${date}
slug: ${input.slug}
name: "${input.name.replace(/"/g, '\\"')}"
base: ${input.base}
locale: ${input.locale}
status: draft
---

## Original input

${input.instructions}
`;
}

export interface CommittedSession {
  name: string;
  base: CvBase;
  locale: 'fr' | 'en';
  sections: Section[];
}

/** Writes the tailored files to disk on the LOCAL checkout (dev checkout or
 *  the prod clone). Never commits — that only happens on "Valider"
 *  (see commitTailoredSession), and never at all when NODE_ENV=development.
 *
 *  Also writes session.json alongside brief.md: the `sections` copy-blocks
 *  otherwise only live in the in-memory Draft (sessions.ts), which is TTL'd
 *  at 24h — without this, a session's copy-blocks are unrecoverable the
 *  moment it's no longer the live draft (e.g. after a server restart, or once
 *  the "historique" dropdown reloads it days later). */
export async function writeTailoredFiles(input: BriefInput, files: TailoredFile[], sections: Section[]): Promise<void> {
  const dir = tailoredDir(input.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'brief.md'), buildBrief(input), 'utf-8');

  const session: CommittedSession = { name: input.name, base: input.base as CvBase, locale: input.locale as 'fr' | 'en', sections };
  await writeFile(path.join(dir, 'session.json'), JSON.stringify(session, null, 2), 'utf-8');

  for (const file of files) {
    const dest = path.join(dir, file.relativePath);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, file.content, 'utf-8');
  }
}

/** Reads back session.json written by writeTailoredFiles — the source for
 *  GET /cv/sessions/:slug once a session is no longer (or never was) the
 *  live in-memory draft. Returns null for an unknown slug or a tailored dir
 *  written before session.json existed. */
export async function readCommittedSession(slug: string): Promise<CommittedSession | null> {
  const raw = await readFile(path.join(tailoredDir(slug), 'session.json'), 'utf-8').catch(() => null);
  if (!raw) return null;
  return JSON.parse(raw) as CommittedSession;
}

/** Commits + pushes the tailored slug directory in carbon-notes. No-op in dev
 *  (NODE_ENV=development) — tailored content must never reach GitHub while iterating locally. */
export async function commitTailoredSession(slug: string): Promise<{ committed: boolean }> {
  if (config.isDev) {
    return { committed: false };
  }

  const dir = tailoredDir(slug);
  // Confirm the draft was actually written before trying to commit it.
  await readdir(dir);

  const relativeDir = path.join('cv', 'tailored', slug);
  await run('git', ['add', relativeDir], config.carbonNotesPath);
  await run('git', ['commit', '-m', `Add tailored CV: ${slug}`], config.carbonNotesPath);
  await run('git', ['push'], config.carbonNotesPath);
  return { committed: true };
}

export async function pullContentRepos(): Promise<void> {
  if (config.isDev) return; // dev reads local checkouts directly, no pull needed
  await run('git', ['pull', '--ff-only'], config.carbonNotesPath);
  await run('git', ['pull', '--ff-only'], config.bismuthBlogPath);
}

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.ts';
import type { TailoredFile } from './sessions.ts';

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

/** Writes the tailored files to disk on the LOCAL checkout (dev checkout or
 *  the prod clone). Never commits — that only happens on "Valider"
 *  (see commitTailoredSession), and never at all when NODE_ENV=development. */
export async function writeTailoredFiles(input: BriefInput, files: TailoredFile[]): Promise<void> {
  const dir = tailoredDir(input.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'brief.md'), buildBrief(input), 'utf-8');

  for (const file of files) {
    const dest = path.join(dir, file.relativePath);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, file.content, 'utf-8');
  }
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

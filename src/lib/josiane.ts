import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';

export type CvBase = 'short' | 'detailed' | 'career-channel';

const SKILL_DIR = 'skills/josiane-cv-editorial-director';

const BASE_REFERENCE_FILE: Record<CvBase, string> = {
  short: '03-version-courte.md',
  detailed: '04-version-detaillee.md',
  'career-channel': '05-career-channel.md',
};

// Always-loaded files (per SKILL.md §1 "Charger le contexte avant toute intervention"),
// plus the one reference file matched to the requested base.
const ALWAYS_LOADED = ['SKILL.md', 'references/01-positionnement-florian.md', 'references/02-regles-editoriales-communes.md', 'references/09-resultats.md'];

const cache = new Map<CvBase, { content: string; loadedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function readSkillFile(relativePath: string): Promise<string> {
  const fullPath = path.join(config.carbonNotesPath, '.claude', SKILL_DIR, relativePath);
  return readFile(fullPath, 'utf-8');
}

/**
 * Loads the Josiane skill (10 files, ~86 KB total in carbon-notes) from the
 * filesystem — never re-implemented here, so skill edits in carbon-notes are
 * picked up automatically (cached 5 min per base to avoid re-reading on every request).
 */
export async function loadJosiane(base: CvBase): Promise<string> {
  const now = Date.now();
  const cached = cache.get(base);
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.content;

  const files = [...ALWAYS_LOADED, `references/${BASE_REFERENCE_FILE[base]}`];
  const contents = await Promise.all(files.map(readSkillFile));
  const content = contents.join('\n\n---\n\n');
  cache.set(base, { content, loadedAt: now });
  return content;
}

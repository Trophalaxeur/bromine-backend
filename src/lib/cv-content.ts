import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';

export interface CvSource {
  content: string;
  // Real filenames under cv/<locale>/experiences/ — the canonical checklist the fan-out iterates
  // (one rewrite call per priority file, the rest reused as-is), and the order the assembled
  // files are emitted in so the render is deterministic regardless of call-completion order.
  experienceFiles: string[];
  // filename → raw file content, so an individual experience can be sliced out
  // (for a per-file rewrite call, or reused as-is) without a second disk read.
  experienceContents: Record<string, string>;
}

/** Reads the `rewritePriority` frontmatter flag from a raw experience file.
 *  Absent → the experience is reused as-is (no rewrite LLM call) by default;
 *  `high` → always rewritten. Deliberately a simple line match rather than a
 *  full YAML parse — the field is a single scalar and this avoids a dependency.
 *  Scoped to the leading `---` frontmatter block so a stray `rewritePriority:`
 *  line in the body can't flip detection, and lowercased so `High`/`HIGH` count. */
export function rewritePriorityOf(content: string): string | undefined {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return undefined;
  const match = frontmatter[1].match(/^rewritePriority:\s*["']?([A-Za-z]+)["']?\s*$/m);
  return match?.[1].toLowerCase();
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<'fr' | 'en', { value: CvSource; loadedAt: number }>();

/** Concatenates every CV source file for a locale (profile, skills, experiences, ...)
 *  into a single block, frontmatter and all — Josiane already knows how to read
 *  this shape (it's identical to what she reads in a normal editing session).
 *
 *  Cached 5 min per locale, same pattern (and same staleness trade-off) as
 *  josiane.ts's loadJosiane: a mid-window `pullContentRepos()` git pull can
 *  change the underlying files without invalidating the cache, but Florian
 *  iterates on instructions within a session, not on the CV source itself, so
 *  the source is effectively stable across a session's regenerations. */
export async function loadCvSource(locale: 'fr' | 'en'): Promise<CvSource> {
  const now = Date.now();
  const cached = cache.get(locale);
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.value;

  const localeDir = path.join(config.carbonNotesPath, 'cv', locale);
  const topLevelFiles = await readdir(localeDir, { withFileTypes: true });

  const sections: string[] = [];

  // cv/memoire_cv.md — the factual source of truth SKILL.md §2 ranks above the
  // experience files' own prose (context, team, decisions, results, anecdotes
  // not yet folded into cv/{locale}/experiences/*.md). Not locale-specific:
  // same facts feed both the fr and en rewrites. SKILL.md §1 requires
  // consulting it "systématiquement avant toute réécriture" — without it here,
  // Josiane only sees the already-written prose and can't draw on the richer
  // underlying facts when tailoring.
  const memoirePath = path.join(config.carbonNotesPath, 'cv', 'memoire_cv.md');
  const memoire = await readFile(memoirePath, 'utf-8').catch(() => null);
  if (memoire) sections.push(`### cv/memoire_cv.md\n\n${memoire}`);

  for (const entry of topLevelFiles) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = await readFile(path.join(localeDir, entry.name), 'utf-8');
      sections.push(`### cv/${locale}/${entry.name}\n\n${content}`);
    }
  }

  const experiencesDir = path.join(localeDir, 'experiences');
  const allExperienceEntries = await readdir(experiencesDir).catch(() => [] as string[]);
  const experienceFiles = allExperienceEntries.filter((f) => f.endsWith('.md'));
  const experienceContents: Record<string, string> = {};
  for (const file of experienceFiles) {
    const content = await readFile(path.join(experiencesDir, file), 'utf-8');
    experienceContents[file] = content;
    sections.push(`### cv/${locale}/experiences/${file}\n\n${content}`);
  }

  const value: CvSource = { content: sections.join('\n\n---\n\n'), experienceFiles, experienceContents };
  cache.set(locale, { value, loadedAt: now });
  return value;
}

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';

/** Concatenates every CV source file for a locale (profile, skills, experiences, ...)
 *  into a single block, frontmatter and all — Josiane already knows how to read
 *  this shape (it's identical to what she reads in a normal editing session). */
export async function loadCvSource(locale: 'fr' | 'en'): Promise<string> {
  const localeDir = path.join(config.carbonNotesPath, 'cv', locale);
  const topLevelFiles = await readdir(localeDir, { withFileTypes: true });

  const sections: string[] = [];

  for (const entry of topLevelFiles) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = await readFile(path.join(localeDir, entry.name), 'utf-8');
      sections.push(`### cv/${locale}/${entry.name}\n\n${content}`);
    }
  }

  const experiencesDir = path.join(localeDir, 'experiences');
  const experienceFiles = await readdir(experiencesDir).catch(() => [] as string[]);
  for (const file of experienceFiles.filter((f) => f.endsWith('.md'))) {
    const content = await readFile(path.join(experiencesDir, file), 'utf-8');
    sections.push(`### cv/${locale}/experiences/${file}\n\n${content}`);
  }

  return sections.join('\n\n---\n\n');
}

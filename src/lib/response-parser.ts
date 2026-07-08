import path from 'node:path';
import type { CvBase } from './josiane.ts';
import type { TailoredFile, Section } from './sessions.ts';

/**
 * Extracts every ## FILE block into a validated TailoredFile. Shared by the fan-out parsers
 * (core/experience/review). Does NOT enforce a minimum count — callers that require at least one
 * block check `.length` themselves.
 *
 * relativePath is LLM-generated text, indirectly steerable by user-supplied
 * instructions/attachments (prompt injection) — it later gets path.join'd into the tailored
 * directory on disk (writeTailoredFiles in git.ts). Reject anything that would resolve outside
 * that directory (CWE-22) rather than trusting the LLM to have followed the ## FILE: contract.
 *
 * Validated as a POSIX path regardless of host OS (path.posix, not path) — the tailored
 * directory is always a Linux checkout (see README), and path.normalize()'s host-OS rules would
 * silently accept a backslash as a literal filename character on POSIX instead of rejecting it as
 * a (Windows-style) separator. Directory-like results ('.' or a trailing '/') are rejected too —
 * they'd pass the traversal check but blow up writeFile() with EISDIR downstream.
 */
function extractFileBlocks(text: string): TailoredFile[] {
  const files: TailoredFile[] = [];
  const fileBlockRegex = /##\s*FILE:\s*([^\n]+)\n+```(?:markdown|md)?\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(fileBlockRegex)) {
    const relativePath = match[1].trim();
    const normalized = path.posix.normalize(relativePath);
    const looksLikeDirectory = normalized === '.' || normalized.endsWith('/');
    if (relativePath.includes('\\') || looksLikeDirectory || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`LLM response FILE block has an invalid path: "${relativePath}"`);
    }
    const content = match[2].replace(/\n$/, '');
    files.push({ relativePath: normalized, content });
  }
  return files;
}

export interface ParsedCore {
  name: string;
  files: TailoredFile[]; // profile/skills/summary/domains
  alsoRewrite: string[]; // bare experience filenames the core call promoted to a full rewrite
  notes?: string;
}

/** Parses the core-identity call (buildCorePrompt): NAME + core FILE blocks + ## ALSO_REWRITE. */
export function parseCoreResponse(text: string, fallbackName: string): ParsedCore {
  const nameMatch = text.match(/##\s*NAME\s*\n+([^\n]+)/i);
  const name = nameMatch ? nameMatch[1].trim() : fallbackName;
  const files = extractFileBlocks(text);
  if (files.length === 0) {
    throw new Error('Core generation response contained no ## FILE: blocks (expected at least profile.md)');
  }
  return { name, files, alsoRewrite: parseAlsoRewrite(text), notes: parseNotes(text) };
}

export interface ParsedExperience {
  file: TailoredFile;
  notes?: string;
}

/** Parses a single-experience call (buildExperiencePrompt): exactly one FILE block, never a skip. */
export function parseExperienceResponse(text: string): ParsedExperience {
  const files = extractFileBlocks(text);
  if (files.length === 0) {
    throw new Error('Experience generation response contained no ## FILE: block');
  }
  // The contract asks for exactly one file; if the model over-emits, keep the first.
  return { file: files[0], notes: parseNotes(text) };
}

export type ParsedReview = { changed: false } | { changed: true; files: TailoredFile[]; notes?: string };

/** Parses the editorial review call (buildReviewPrompt). Only applies changes when the model
 *  explicitly says `## REVIEW: CHANGES` and emits at least one revised FILE block — an OK verdict
 *  or a malformed response leaves the assembled content untouched. */
export function parseReviewResponse(text: string): ParsedReview {
  if (!/##\s*REVIEW:\s*CHANGES/i.test(text)) return { changed: false };
  const files = extractFileBlocks(text);
  if (files.length === 0) return { changed: false };
  return { changed: true, files, notes: parseNotes(text) };
}

/** Extracts the ## ALSO_REWRITE list as bare experience filenames (strips list markers and any
 *  locale/experiences/ prefix). Stops at the next ## heading so it never swallows ## NOTES. */
function parseAlsoRewrite(text: string): string[] {
  const match = text.match(/##\s*ALSO_REWRITE\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^[-*\s]+/, '').trim())
    .filter((line) => /\.md$/.test(line))
    .map((line) => line.split('/').pop() as string);
}

/**
 * Extracts the optional trailing ## NOTES block (the sanctioned place for the model's remarks —
 * see prompt.ts). Returns undefined when absent or empty. CV markdown never carries a "## NOTES"
 * heading of its own, so a plain match on the first occurrence is safe here.
 */
export function parseNotes(text: string): string | undefined {
  const match = text.match(/##\s*NOTES\s*\n([\s\S]*)$/i);
  const notes = match?.[1].trim();
  return notes || undefined;
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return match ? { frontmatter: match[1], body: match[2] } : { frontmatter: '', body: content };
}

function frontmatterField(frontmatter: string, field: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*"?([^"\\n]*?)"?\\s*$`, 'm'));
  return match?.[1].trim() || undefined;
}

function variantBlock(body: string, base: CvBase): string | undefined {
  const match = body.match(new RegExp(`:::${base}\\n([\\s\\S]*?)\\n:::`));
  return match ? match[1].trim() : undefined;
}

/**
 * Derives copy-paste sections directly from each FILE block's own markdown
 * instead of asking the LLM to re-emit the same prose a second time as plain
 * text (the old ## SECTIONS block) — cuts output tokens roughly in half for
 * files carrying variant blocks, which was the dominant cost on generation
 * latency. Files without ::: blocks (summary.md, domains.md, ...) apply to
 * every variant as-is, so their whole body is the section.
 */
export function deriveSections(files: TailoredFile[], base: CvBase): Section[] {
  const sections: Section[] = [];

  for (const file of files) {
    const { frontmatter, body } = splitFrontmatter(file.content);
    const hasAnyVariantBlock = /:::\S/.test(body);
    const content = hasAnyVariantBlock ? variantBlock(body, base) : body.trim();
    if (!content) continue; // e.g. file only carries blocks for other variants

    let title: string;
    if (file.relativePath.endsWith('/profile.md')) {
      title = 'Profil';
    } else if (file.relativePath.includes('/experiences/')) {
      const company = frontmatterField(frontmatter, 'company');
      const role = frontmatterField(frontmatter, 'role');
      title = [company, role].filter(Boolean).join(' — ') || file.relativePath;
    } else {
      const type = frontmatterField(frontmatter, 'type');
      title = type ? type.charAt(0).toUpperCase() + type.slice(1) : file.relativePath;
    }

    sections.push({ title, content, copyable: true });
  }

  return sections;
}

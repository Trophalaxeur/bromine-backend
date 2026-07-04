import path from 'node:path';
import type { CvBase } from './josiane.ts';
import type { TailoredFile, Section } from './sessions.ts';

export interface ParsedGeneration {
  name: string;
  files: TailoredFile[];
}

/** Parses the structured LLM output produced from the contract in prompt.ts. */
export function parseGenerationResponse(text: string, fallbackName: string): ParsedGeneration {
  const nameMatch = text.match(/##\s*NAME\s*\n+([^\n]+)/i);
  const name = nameMatch ? nameMatch[1].trim() : fallbackName;

  const files: TailoredFile[] = [];
  const fileBlockRegex = /##\s*FILE:\s*([^\n]+)\n+```(?:markdown|md)?\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(fileBlockRegex)) {
    const relativePath = match[1].trim();

    // relativePath is LLM-generated text, indirectly steerable by user-supplied
    // instructions/attachments (prompt injection) — it later gets path.join'd
    // into the tailored directory on disk (writeTailoredFiles in git.ts).
    // Reject anything that would resolve outside that directory (CWE-22)
    // rather than trusting the LLM to have followed the ## FILE: contract.
    //
    // Validated as a POSIX path regardless of host OS (path.posix, not path) —
    // the tailored directory is always a Linux checkout (see README), and
    // path.normalize()'s host-OS rules would silently accept a backslash as a
    // literal filename character on POSIX instead of rejecting it as a
    // (Windows-style) separator. Directory-like results ('.' or a trailing
    // '/') are rejected too — they'd pass the traversal check but blow up
    // writeFile() with EISDIR downstream.
    const normalized = path.posix.normalize(relativePath);
    const looksLikeDirectory = normalized === '.' || normalized.endsWith('/');
    if (relativePath.includes('\\') || looksLikeDirectory || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`LLM response FILE block has an invalid path: "${relativePath}"`);
    }

    const content = match[2].replace(/\n$/, '');
    files.push({ relativePath: normalized, content });
  }

  if (files.length === 0) {
    throw new Error('LLM response contained no ## FILE: blocks — cannot write tailored content or render a PDF');
  }

  return { name, files };
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

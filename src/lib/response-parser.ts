import path from 'node:path';
import type { TailoredFile, Section } from './sessions.ts';

export interface ParsedGeneration {
  name: string;
  files: TailoredFile[];
  sections: Section[];
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

  const sectionsMatch = text.match(/##\s*SECTIONS\s*\n+```json\n([\s\S]*?)```/i);
  let sections: Section[] = [];
  if (sectionsMatch) {
    try {
      const raw = JSON.parse(sectionsMatch[1]) as { title: string; content: string }[];
      sections = raw.map((s) => ({ title: s.title, content: s.content, copyable: true as const }));
    } catch (err) {
      // Fall through with empty sections rather than failing the whole generation —
      // the PDF and raw files are still usable even if the copy-blocks parse fails.
      console.warn('Failed to parse ## SECTIONS block from LLM response:', err);
      sections = [];
    }
  }

  if (files.length === 0) {
    throw new Error('LLM response contained no ## FILE: blocks — cannot write tailored content or render a PDF');
  }

  return { name, files, sections };
}

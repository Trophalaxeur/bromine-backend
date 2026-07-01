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
    const content = match[2].replace(/\n$/, '');
    files.push({ relativePath, content });
  }

  const sectionsMatch = text.match(/##\s*SECTIONS\s*\n+```json\n([\s\S]*?)```/i);
  let sections: Section[] = [];
  if (sectionsMatch) {
    try {
      const raw = JSON.parse(sectionsMatch[1]) as { title: string; content: string }[];
      sections = raw.map((s) => ({ title: s.title, content: s.content, copyable: true as const }));
    } catch {
      // Fall through with empty sections rather than failing the whole generation —
      // the PDF and raw files are still usable even if the copy-blocks parse fails.
      sections = [];
    }
  }

  if (files.length === 0) {
    throw new Error('LLM response contained no ## FILE: blocks — cannot write tailored content or render a PDF');
  }

  return { name, files, sections };
}

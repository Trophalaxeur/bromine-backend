import { randomUUID } from 'node:crypto';
import type { GenerationReport } from './generation-report.ts';

export interface TailoredFile {
  /** Path relative to cv/tailored/<slug>/, e.g. "fr/profile.md" or "fr/experiences/2025-bluewhale.md" */
  relativePath: string;
  content: string;
}

export interface Section {
  title: string;
  content: string;
  copyable: true;
}

/** One generation attempt on a session — appended (never overwritten) each time the same
 *  sessionId is regenerated, so the extension can show what changed between attempts while
 *  Florian iterates on the instructions. */
export interface GenerationAttempt {
  instructions: string;
  name: string;
  timestamp: number;
  report?: GenerationReport;
}

export interface Draft {
  sessionId: string;
  slug: string;
  name: string;
  base: 'short' | 'detailed' | 'career-channel';
  locale: 'fr' | 'en';
  instructions: string;
  files: TailoredFile[];
  sections: Section[];
  report?: GenerationReport;
  // Trail of attempts for this session, oldest→newest; report above always equals history.at(-1).report.
  history: GenerationAttempt[];
  pdfPath: string;
  createdAt: number;
}

/** Max attempts retained per session — bounds the in-memory draft (and committed session.json). */
export const HISTORY_CAP = 10;

const TTL_MS = 24 * 60 * 60 * 1000;
const drafts = new Map<string, Draft>();

/** Creates a fresh session (no id given) or overwrites an in-progress one
 *  (id given and still live) — re-generating always keeps the same sessionId
 *  so the extension's stored reference and the rendered PDF path stay valid. */
export function upsertDraft(sessionId: string | undefined, data: Omit<Draft, 'sessionId' | 'createdAt'>): Draft {
  const id = sessionId ?? randomUUID();
  const draft: Draft = { ...data, sessionId: id, createdAt: Date.now() };
  drafts.set(id, draft);
  return draft;
}

export function getDraft(sessionId: string): Draft | undefined {
  const draft = drafts.get(sessionId);
  if (draft && Date.now() - draft.createdAt > TTL_MS) {
    drafts.delete(sessionId);
    return undefined;
  }
  return draft;
}

export function deleteDraft(sessionId: string): boolean {
  return drafts.delete(sessionId);
}

// Periodic sweep so abandoned drafts (browser closed mid-session) don't leak
// memory indefinitely — 24h TTL matches the "session in progress" window.
setInterval(
  () => {
    const now = Date.now();
    for (const [id, draft] of drafts) {
      if (now - draft.createdAt > TTL_MS) drafts.delete(id);
    }
  },
  60 * 60 * 1000
).unref();

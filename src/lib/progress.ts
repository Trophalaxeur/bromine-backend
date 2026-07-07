import type { Section } from './sessions.ts';
import type { GenerationReport } from './generation-report.ts';

export type GenerationPhase = 'calling_llm' | 'writing_files' | 'rendering_pdf' | 'ready' | 'error';

export interface GenerationResult {
  sessionId: string;
  slug: string;
  name: string;
  sections: Section[];
  report?: GenerationReport;
  pdf_url: string;
}

export interface GenerationProgress {
  phase: GenerationPhase;
  label: string;
  startedAt: number;
  phaseStartedAt: number;
  error?: string;
  result?: GenerationResult;
}

const LABELS: Record<GenerationPhase, string> = {
  calling_llm: 'Claude rédige votre CV…',
  writing_files: 'Écriture des fichiers…',
  rendering_pdf: 'Génération du PDF…',
  ready: 'Terminé',
  error: 'Échec',
};

const progress = new Map<string, GenerationProgress>();

/** POST /cv/generate calls this once, synchronously, before returning —
 *  so a client polling immediately after the response always finds an entry. */
export function startProgress(sessionId: string): void {
  const now = Date.now();
  progress.set(sessionId, { phase: 'calling_llm', label: LABELS.calling_llm, startedAt: now, phaseStartedAt: now });
}

export function setPhase(sessionId: string, phase: GenerationPhase): void {
  const current = progress.get(sessionId);
  progress.set(sessionId, { phase, label: LABELS[phase], startedAt: current?.startedAt ?? Date.now(), phaseStartedAt: Date.now() });
}

export function setReady(sessionId: string, result: GenerationResult): void {
  const current = progress.get(sessionId);
  progress.set(sessionId, {
    phase: 'ready',
    label: LABELS.ready,
    startedAt: current?.startedAt ?? Date.now(),
    phaseStartedAt: Date.now(),
    result,
  });
}

export function setError(sessionId: string, error: string): void {
  const current = progress.get(sessionId);
  progress.set(sessionId, { phase: 'error', label: LABELS.error, startedAt: current?.startedAt ?? Date.now(), phaseStartedAt: Date.now(), error });
}

export function getProgress(sessionId: string): GenerationProgress | undefined {
  return progress.get(sessionId);
}

// Progress entries are short-lived scaffolding for one generation — once the
// client has polled through to 'ready'/'error' there's nothing left to read,
// but an abandoned generation (extension closed mid-run) would otherwise sit
// here forever. 2h covers even a very slow run with margin.
const CLEANUP_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(
  () => {
    const now = Date.now();
    for (const [id, p] of progress) {
      if (now - p.startedAt > CLEANUP_TTL_MS) progress.delete(id);
    }
  },
  60 * 60 * 1000
).unref();

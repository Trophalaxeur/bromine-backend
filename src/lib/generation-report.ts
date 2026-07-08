/**
 * Structured record of what a generation actually did — surfaced to the extension (max info to
 * the front) and committed alongside the tailored CV for traceability. Assembled in one place
 * (runGeneration) from the pieces each stage produces; §3 of the CV-generation plan.
 *
 * In PR1 `callSummary`, `notes`, and `review` are populated — the core+experience fan-out (§1) and
 * its editorial review pass both land in this PR. Only `pageCheck` is still deferred, filled in once
 * the page-fit loop (§5) lands. The shape is defined in full now so downstream consumers don't churn later.
 */

export interface CallSummary {
  // Two buckets only — experiences are never dropped, so every experience file is in exactly one
  // of these. A file can *additionally* be touched later by the review or page-fit steps; these
  // lists record what the generation fan-out itself did, not the final state of every file.
  experiencesRewritten: string[]; // freshly rewritten by an LLM call
  experiencesReused: string[]; // left as-is, no LLM call spent on them
}

export interface ReviewOutcome {
  changed: boolean;
  filesChanged?: string[];
  notes?: string; // Josiane's explanation of what changed and why (incl. anything pulled for lacking a source)
}

export interface PageCheckOutcome {
  status: 'ok' | 'over_budget';
  finalPageCount: number;
  escalationSteps: ('skills_condense' | 'tight_margins' | 'experience_condense')[]; // steps that actually ran, in order
  filesTouched?: string[]; // which files skills_condense/experience_condense actually rewrote
}

export interface GenerationReport {
  callSummary: CallSummary;
  notes?: string; // aggregated per-call ## NOTES fragments
  review?: ReviewOutcome; // §1's editorial pass — best-effort, so absent when the review step is skipped or fails
  pageCheck?: PageCheckOutcome; // §5, 'short' base only — absent until that lands
}

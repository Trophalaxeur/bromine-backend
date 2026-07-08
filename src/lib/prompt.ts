import type { CvBase } from './josiane.ts';
import type { TailoredFile } from './sessions.ts';

interface CommonInput {
  base: CvBase;
  locale: 'fr' | 'en';
  instructions: string;
}

export interface CorePromptInput extends CommonInput {
  name?: string;
  // Only the core call receives the actual image, so only it needs this flag.
  hasAttachment: boolean;
  // Experiences always rewritten (their own calls run regardless of this prompt).
  priorityFiles: string[];
  // Experiences reused as-is by default — the core call may promote some into ## ALSO_REWRITE.
  otherFiles: string[];
}

export interface ExperiencePromptInput extends CommonInput {
  /** Bare filename under cv/<locale>/experiences/, e.g. "2025-bluewhale.md". */
  experienceFile: string;
  /** Text the core call transcribed from the attached image (job offer etc.) via ## ATTACHMENT_CONTEXT.
   *  The per-experience calls run in parallel and never receive the image itself, so this is how its
   *  content reaches them. Undefined when no image was attached. */
  attachmentContext?: string;
}

export interface ReviewPromptInput {
  base: CvBase;
  locale: 'fr' | 'en';
  instructions: string;
  /** The full assembled set of tailored files to review. */
  files: TailoredFile[];
  /** The core call's transcription of the attached image (## ATTACHMENT_CONTEXT), so the reviewer
   *  can judge whether the emphasis actually matches the offer — it never sees the image itself. */
  attachmentContext?: string;
}

function attachmentNote(hasAttachment: boolean): string {
  return hasAttachment ? '\nAn image is attached (job offer screenshot or similar) — read it as additional context.' : '';
}

// The per-experience calls never receive the image, only the text the core call transcribed from it.
function attachmentContextNote(context?: string): string {
  return context ? `\n\nContext from an image Florian attached (job offer screenshot or similar), transcribed by the core call:\n${context}` : '';
}

const NOTES_CONTRACT = `## NOTES
<optional, and the ONLY place for free-form remarks: flag anything Florian should know — an ambiguous instruction and how you resolved it, an angle you couldn't support from the CV source, a request you deliberately didn't apply and why. Omit this block entirely if you have nothing to flag. Never put remarks anywhere else — stray prose outside the blocks above is dropped by the parser.>`;

/**
 * Core-identity call: NAME + profile/skills/summary/domains. Experiences are tailored in
 * separate parallel calls, so this prompt emits NO experience FILE blocks — but it does decide,
 * via ## ALSO_REWRITE, whether any normally-reused experience warrants a rewrite for this request.
 *
 * Josiane's SKILL.md (in the cached system prompt) defines the editorial mandate; this adds only
 * the machine-parseable output contract on top, without touching the skill file in carbon-notes.
 */
export function buildCorePrompt(input: CorePromptInput): string {
  const { base, locale } = input;
  const nameInstruction = input.name
    ? `The application name is: "${input.name}".`
    : 'No name was given — deduce a short name (company + role, or context) from the instructions below and put it in the NAME block.';

  const priorityList = input.priorityFiles.map((f) => `  - ${f}`).join('\n') || '  (none)';
  const otherList = input.otherFiles.map((f) => `  - ${f}`).join('\n') || '  (none)';

  return `You are adapting Florian's CV, following your editorial mandate exactly as described in SKILL.md above. Target variant: "${base}". Locale: ${locale}.

${nameInstruction}

Instructions from Florian:
${input.instructions}${attachmentNote(input.hasAttachment)}

In THIS call you handle the CV's core identity only: the NAME, ${locale}/profile.md, and the cross-cutting sections ${locale}/skills.md, ${locale}/summary.md, ${locale}/domains.md. The individual work experiences are tailored in SEPARATE parallel calls — do NOT emit any ## FILE block for ${locale}/experiences/* here.

Every experience is always kept in the CV — nothing is ever dropped; this is about emphasis, not curation. These experiences are always rewritten by the other calls regardless of what you do:
${priorityList}
These are reused as-is by default (no rewrite):
${otherList}
If — and only if — this specific request makes one of those reused experiences genuinely worth a full rewrite (e.g. a posting squarely about applied research would warrant rewriting the INRIA experience), list its bare filename in the ## ALSO_REWRITE block so it gets its own tailoring call. Otherwise leave that block out.

Emphasis strategy, decided from the instructions: for a targeted opportunity, foreground what's relevant to it; for a repositioning/emphasis request, reorient wording toward the requested angle. Either way no experience is dropped. For enrichment, consult \`memoire_cv.md\` (already in your context) for factual actions, metrics, or context supporting the angle — strengthen without inventing.

Respond with EXACTLY this structure. The only place free-form prose is allowed is the optional ## NOTES block, which comes ${input.hasAttachment ? 'just before the final ## ATTACHMENT_CONTEXT block' : 'at the very end'}:

## NAME
<short name — company + role for a targeted opportunity, or a short label like "Lead Dev repositioning" for a generic repositioning request>

## FILE: ${locale}/profile.md
\`\`\`markdown
<the full file: YAML frontmatter as in the real cv/${locale}/profile.md, then the body with its variant blocks — the :::${base}::: block rewritten for the emphasis, any other variant blocks preserved from the source>
\`\`\`

(Also emit a ## FILE block for ${locale}/skills.md, ${locale}/summary.md, and/or ${locale}/domains.md whenever they help carry the emphasis: for skills.md reorder each category's item list and adjust which items are **bold** — bold renders as primary — to foreground what was asked. The skill category ORDER (Leadership, Delivery, Quality, Frontend, ...) is fixed site-wide and cannot change per-CV. Omit a core file entirely only when the request calls for no change to it — it then falls back to the real CV.)

## ALSO_REWRITE
<zero or more of the reused-as-is experience filenames listed above, one bare filename per line (e.g. 2011-inria.md), that THIS request warrants rewriting. Omit this whole block if none.>

${NOTES_CONTRACT}${input.hasAttachment ? `

## ATTACHMENT_CONTEXT
This block MUST be the very last thing in your response — the ## NOTES block, if you emit one, comes BEFORE it. Everything from the line below to the end of your response is treated as the image transcription. Faithfully transcribe the attached image into text: the job offer's role, requirements, keywords, and any constraints. The per-experience tailoring calls run in parallel and CANNOT see the image — this block is the only way its content reaches them. Transcribe, don't editorialize. Omit the whole block if there is genuinely nothing in the image.` : ''}`;
}

/**
 * Single-experience call: tailors exactly one cv/<locale>/experiences/ file. The file's current
 * content is in the cached system prompt (full CV source). Emits the full file — same shape as
 * the source, including all variant blocks — so the tailored slug renders identically to today.
 */
export function buildExperiencePrompt(input: ExperiencePromptInput): string {
  const { base, locale, experienceFile } = input;

  return `You are adapting Florian's CV, following your editorial mandate exactly as described in SKILL.md above. Target variant: "${base}". Locale: ${locale}.

Instructions from Florian:
${input.instructions}${attachmentContextNote(input.attachmentContext)}

In THIS call you tailor exactly ONE experience: cv/${locale}/experiences/${experienceFile}. Its current content is in your context (the CV source above). Rewrite it to carry the request's emphasis — reorder and reword bullets *within* the experience, and strengthen with facts from \`memoire_cv.md\` where they support the angle; never invent. Do NOT drop the experience and do NOT touch any other file.

If this file bundles several distinct clients/missions (some do — e.g. a freelance-consulting file covering multiple short missions), keep every mission present and apply the emphasis within each.

Respond with EXACTLY this structure. The only place free-form prose is allowed is the optional ## NOTES block at the very end:

## FILE: ${locale}/experiences/${experienceFile}
\`\`\`markdown
<the full file: the exact frontmatter shape of the real file, then the body with its variant blocks (:::short:::, :::career-channel:::, :::detailed::: as present in the source), with the :::${base}::: block rewritten for the emphasis and the other blocks preserved from the source>
\`\`\`

${NOTES_CONTRACT}`;
}

/**
 * Editorial review call: runs once over the full assembled set (all core + experience files),
 * closing the coherence/consistency/anti-hallucination gap that splitting generation into
 * independent parallel calls opens up. This is the enforcement point for "no unsourced claims".
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const { base, locale } = input;
  const fileBlocks = input.files.map((f) => `## FILE: ${f.relativePath}\n\`\`\`markdown\n${f.content}\n\`\`\``).join('\n\n');

  return `You are the editorial reviewer for a CV that was just assembled from several INDEPENDENT tailoring calls (one for the core identity, one per experience). Because they ran without seeing each other's output, review the whole set for consistency. Follow your editorial mandate in SKILL.md above. Target variant: "${base}". Locale: ${locale}.

Original instructions from Florian:
${input.instructions}${attachmentContextNote(input.attachmentContext)}

Check specifically for:
- Coherence between ${locale}/skills.md's emphasis and what the experiences (freshly rewritten AND reused-as-is) actually foreground.
- Tone/style consistency across files, since they were drafted independently.
- Whether SKILL.md's editorial mandate was actually followed.
- ANTI-HALLUCINATION (hard requirement): every claim in a rewritten file must be traceable to a specific sentence in the CV source or \`memoire_cv.md\` (both in your context above). Rewrite or REMOVE anything you cannot trace — do not merely flag it — and say what you pulled and why in ## NOTES.

The assembled tailored files:

${fileBlocks}

Respond with EXACTLY one of these two shapes and nothing else:

## REVIEW: OK

— or —

## REVIEW: CHANGES

followed by a ## FILE block (same format as above, full file content) for ONLY each file you are revising — every path MUST be one of the files shown above; do NOT introduce new files (any unknown path is dropped) — then:

${NOTES_CONTRACT}`;
}

import type { CvBase } from './josiane.ts';

export interface GenerateInput {
  name?: string;
  base: CvBase;
  locale: 'fr' | 'en';
  instructions: string;
  hasAttachment: boolean;
  // Real filenames under cv/<locale>/experiences/ — enumerated below as a
  // literal checklist rather than left to the LLM's recall of the source
  // dump further up its context, since that's what let a repositioning
  // request silently keep only the one experience it actively rewrote.
  experienceFiles: string[];
}

/**
 * The dynamic (non-cached) part of the prompt. Josiane's SKILL.md defines the
 * editorial contract; this adds the machine-parseable output contract the
 * backend needs on top, without touching the skill file in carbon-notes.
 */
export function buildUserPrompt(input: GenerateInput): string {
  const nameInstruction = input.name
    ? `The application name is: "${input.name}".`
    : 'No name was given — deduce a short name (company + role, or context) from the instructions below and put it in the NAME block.';

  const attachmentNote = input.hasAttachment ? '\nAn image is attached (job offer screenshot or similar) — read it as additional context.' : '';

  const experienceChecklist = input.experienceFiles.map((f) => `  - ${input.locale}/experiences/${f}`).join('\n');

  return `You are adapting Florian's CV, following your editorial mandate exactly as described in SKILL.md above. Target variant: "${input.base}". Locale: ${input.locale}.

${nameInstruction}

Instructions from Florian:
${input.instructions}${attachmentNote}

Two different kinds of instructions need two different strategies — decide which one this is before touching any file:

- **Targeted to a specific opportunity** (a named job posting, client, or attached offer): curate down to the experiences genuinely relevant to that opportunity, as SKILL.md describes.
- **A repositioning / emphasis request** (e.g. "put forward the Lead Dev side", "orient this more toward architecture") with no specific opportunity named: this is NOT a request to delete unrelated experiences. The real cv/${input.locale}/experiences/ directory currently contains exactly these ${input.experienceFiles.length} files — treat this as a literal checklist, not a recollection exercise: emit one ## FILE block for EVERY name below (rewritten with the requested emphasis), in this exact order, and do not skip any of them:
${experienceChecklist}
  **Never reorder this list** (reordering is confusing for Florian and serves no purpose here). Express the requested emphasis by rewriting wording and reordering bullets *within* each experience, never by dropping one from the checklist. For enrichment, consult \`memoire_cv.md\` (already in your context as part of the CV source) to find additional factual actions, metrics, or context that support the requested angle — use it to add or strengthen bullets without inventing anything. Files without \`:::\` variant blocks (e.g. \`summary.md\`, \`domains.md\`) can and should be modified when they help carry the repositioning — there is no multi-variant impact concern for those files. Only drop an experience if Florian's instructions explicitly say to remove it — the checklist above assumes none are dropped by default.

When in doubt about which kind of request this is, default to keeping all experiences — dropping content is the harder-to-notice mistake. Before responding, count your own ## FILE: ${input.locale}/experiences/ blocks against the checklist above (for a repositioning request, the counts must match exactly).

Respond with EXACTLY this structure. The only place free-form prose is allowed is the optional ## NOTES block at the very end — put nothing else outside the blocks below:

## NAME
<short name — company + role for a targeted opportunity, or a short label like "Lead Dev repositioning" for a generic repositioning request>

## FILE: ${input.locale}/profile.md
\`\`\`markdown
<full file content: YAML frontmatter identical in shape to the real cv/${input.locale}/profile.md, then the body with the :::${input.base}::: block (and other variant blocks if you also drafted them)>
\`\`\`

## FILE: ${input.locale}/experiences/<matching-filename>.md
\`\`\`markdown
<one such block PER experience you chose to include — see the two strategies above for which experiences that means — reusing the exact filename from the real cv/${input.locale}/experiences/ directory>
\`\`\`

(repeat the ## FILE block for every file you are tailoring — profile.md, the experiences per the strategy above, and skills.md whenever the instructions ask to reorient/emphasize a particular angle: reorder each category's item list and adjust which items are wrapped in **bold** — bold items render as highlighted/primary — to foreground what was asked for. Omit skills.md, education.md etc. only when the instructions don't call for any change to them.)

Some experience files bundle several distinct clients/missions in one file (e.g. a freelance-consulting file covering 3 short missions for 3 different clients, each with its own bullet in :::short::: and its own subsection in :::career-channel:::/:::detailed:::). If an instruction names a specific client or mission rather than a whole experience, that mission is almost always inside one of these bundled files, not its own file — grep the real experiences/ content for the name before concluding it doesn't exist. Apply the instruction by editing that file's content (drop or keep the matching bullet/subsection in every variant block it appears in), not by including or excluding the file wholesale.

Note on skill categories: the category order (Leadership, Delivery, Quality, Frontend, ...) is fixed site-wide and cannot be changed per-CV — only the item order and bold emphasis within each category are yours to edit.

Do not emit a SECTIONS block — the backend derives copy-paste sections directly from the FILE blocks above.

## NOTES
<optional, and the ONLY place for remarks: flag anything Florian should know — an ambiguous instruction and how you resolved it, an angle you couldn't support from the CV source, a request you deliberately didn't apply and why. Omit this block entirely if you have nothing to flag. Never put remarks anywhere else — stray prose outside the blocks above is dropped by the parser.>`;
}

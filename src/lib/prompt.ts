import type { CvBase } from './josiane.ts';

export interface GenerateInput {
  name?: string;
  base: CvBase;
  locale: 'fr' | 'en';
  instructions: string;
  hasAttachment: boolean;
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

  return `You are adapting Florian's CV for a specific opportunity, following your editorial mandate exactly as described in SKILL.md above. Target variant: "${input.base}". Locale: ${input.locale}.

${nameInstruction}

Instructions from Florian:
${input.instructions}${attachmentNote}

Respond with EXACTLY this structure (no extra prose before or after):

## NAME
<short name for this application — company + role, e.g. "ACME Corp — Tech Lead Backend">

## FILE: ${input.locale}/profile.md
\`\`\`markdown
<full file content: YAML frontmatter identical in shape to the real cv/${input.locale}/profile.md, then the body with the :::${input.base}::: block (and other variant blocks if you also drafted them)>
\`\`\`

## FILE: ${input.locale}/experiences/<matching-filename>.md
\`\`\`markdown
<one such block PER experience you chose to include — only the ones relevant to this opportunity, reusing the exact filename from the real cv/${input.locale}/experiences/ directory>
\`\`\`

(repeat the ## FILE block for every file you are tailoring — profile.md and only the relevant experiences/*.md; omit skills.md, education.md etc. unless you are meaningfully changing them)

## SECTIONS
\`\`\`json
[
  { "title": "Profil", "content": "<the ${input.base} block body for profile.md, plain text ready to paste>" },
  { "title": "<Company — Role>", "content": "<the ${input.base} block body for that experience, plain text ready to paste>" }
]
\`\`\`

The SECTIONS array must mirror the FILE blocks — one entry per file that has user-facing prose, in the same order, with clean copy-paste-ready text (no markdown fences, no frontmatter).`;
}

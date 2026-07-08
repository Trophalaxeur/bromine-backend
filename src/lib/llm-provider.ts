import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';

export interface LLMImageAttachment {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface LLMRequest {
  /** Stable, cacheable part: Josiane + CV source. */
  systemPrompt: string;
  /** Variable part: user instructions / job offer text. */
  userPrompt: string;
  attachment?: LLMImageAttachment;
  /** Per-call output cap. The parallel fan-out sends much smaller, targeted prompts
   *  (one file each) than the old monolith, so each can afford a tight cap — which
   *  also keeps non-streaming requests well under the SDK's HTTP timeout window. */
  maxTokens?: number;
}

export interface ILLMProvider {
  complete(request: LLMRequest): Promise<string>;
}

/**
 * Dev-only provider: shells out to the local Claude Code CLI, reusing its
 * existing auth so no separate API key is needed while iterating locally.
 */
class ClaudeCLIProvider implements ILLMProvider {
  async complete(request: LLMRequest): Promise<string> {
    if (request.attachment) {
      throw new Error(
        'Image attachments are not supported through the Claude CLI provider — ' +
          'set USE_CLAUDE_CLI=false and configure ANTHROPIC_API_KEY to test that path.'
      );
    }

    // The system prompt (Josiane + full CV source + memoire_cv.md) regularly
    // exceeds Linux's per-argument execve() limit (MAX_ARG_STRLEN, 128 KiB) —
    // passing it as a CLI arg fails with `spawn E2BIG`. Write it to a temp file
    // and use --system-prompt-file instead; the user prompt goes over stdin
    // for the same reason (smaller today, but no reason to leave it exposed to
    // the same limit if a pasted job offer ever gets long).
    const dir = await mkdtemp(path.join(tmpdir(), 'bromine-sysprompt-'));
    const systemPromptFile = path.join(dir, 'system-prompt.txt');
    try {
      await writeFile(systemPromptFile, request.systemPrompt, 'utf-8');

      return await new Promise((resolve, reject) => {
        const child = spawn('claude', ['-p', '--system-prompt-file', systemPromptFile], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`claude CLI exited with code ${code}: ${stderr}`));
          else resolve(stdout.trim());
        });
        child.stdin.end(request.userPrompt);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

class AnthropicSDKProvider implements ILLMProvider {
  #client: Anthropic;

  constructor(apiKey: string) {
    // maxRetries 3 (SDK default is 2): the parallel fan-out fires ~5 independent calls per
    // generation, so a per-call retry on transient errors (429/5xx/connection — handled by the
    // SDK, not us) is what keeps "one flaky sub-call fails the whole generation" from getting
    // more likely than the old single call, not less.
    this.#client = new Anthropic({ apiKey, maxRetries: 3 });
  }

  async complete(request: LLMRequest): Promise<string> {
    const userContent: Anthropic.MessageParam['content'] = request.attachment
      ? [
          { type: 'text', text: request.userPrompt },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: request.attachment.mimeType,
              data: request.attachment.base64,
            },
          },
        ]
      : request.userPrompt;

    const response = await this.#client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: request.maxTokens ?? 8192,
      // 1h TTL (not the 5min default) — Florian iterates on the same base/locale
      // across several regenerations within a session while tweaking
      // instructions, and the system prompt (Josiane + full CV source +
      // memoire_cv.md) is the expensive part to reprocess from cold each time.
      system: [{ type: 'text', text: request.systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: userContent }],
    });

    // A truncated response silently drops whatever the call was mid-way through —
    // fail loudly rather than hand response-parser.ts a partial ## FILE: block.
    // With the fan-out's small per-call caps this shouldn't trigger; if it does,
    // the cap for that call type is undersized (see prompt.ts sizing note).
    if (response.stop_reason === 'max_tokens') {
      throw new Error(`Anthropic response truncated at max_tokens (${response.usage.output_tokens} output tokens) — the call is incomplete.`);
    }

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') throw new Error('Anthropic response contained no text block');
    return textBlock.text;
  }
}

export function createLLMProvider(): ILLMProvider {
  if (config.useClaudeCli) return new ClaudeCLIProvider();
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is required when USE_CLAUDE_CLI is not enabled');
  return new AnthropicSDKProvider(config.anthropicApiKey);
}

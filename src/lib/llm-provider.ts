import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';

export interface LLMImageAttachment {
  base64: string;
  mimeType: string;
}

export interface LLMRequest {
  /** Stable, cacheable part: Josiane + CV source. */
  systemPrompt: string;
  /** Variable part: user instructions / job offer text. */
  userPrompt: string;
  attachment?: LLMImageAttachment;
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
    return new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', request.userPrompt, '--system-prompt', request.systemPrompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
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
    });
  }
}

class AnthropicSDKProvider implements ILLMProvider {
  #client: Anthropic;

  constructor(apiKey: string) {
    this.#client = new Anthropic({ apiKey });
  }

  async complete(request: LLMRequest): Promise<string> {
    const userContent: Anthropic.MessageParam['content'] = request.attachment
      ? [
          { type: 'text', text: request.userPrompt },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: request.attachment.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
              data: request.attachment.base64,
            },
          },
        ]
      : request.userPrompt;

    const response = await this.#client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: [{ type: 'text', text: request.systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    });

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

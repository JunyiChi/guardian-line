import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import { config } from '../config';
import { log } from '../privacy/log';

export const PROVIDERS = ['gemini', 'anthropic'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type Tier = 'fast' | 'precise';

/** Must fit inside the 8s scoring tick (the precise check runs right after a fast one). */
const TIMEOUT_MS = { fast: 6_000, precise: 12_000 } as const;
const RATE_LIMIT_RETRIES = 4;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

/**
 * One completion: a cacheable system prompt split into a stable part and a per-country part, plus
 * the per-call user message. Returns raw text (expected to be JSON).
 */
export interface Request {
  system: string[];
  user: string;
  tier: Tier;
  /** zod schema for providers with native structured output. */
  schema: z.ZodType;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfterMs?: number) {
    super(message);
  }
}

let warned = false;
/** LLM_PROVIDER, or gemini if it names something unknown (logged once; Jev doesn't use it). */
export function currentProvider(): Provider {
  const p = config.llm.provider as Provider;
  if (PROVIDERS.includes(p)) return p;
  if (!warned) log.warn('detector', `unknown LLM_PROVIDER "${p}" (use ${PROVIDERS.join(' or ')}); the chat-model detector will use gemini`);
  warned = true;
  return 'gemini';
}

export function currentModel(tier: Tier = 'fast'): string {
  const c = config.llm[currentProvider()];
  return tier === 'fast' ? c.fastModel : c.preciseModel;
}

function retryAfter(h: string | null | undefined): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

let anthropicClient: Anthropic | null = null;
async function anthropic(req: Request): Promise<string> {
  anthropicClient ??= new Anthropic({
    apiKey: config.llm.anthropic.apiKey || undefined,
    maxRetries: 0, // 429s are retried by withBackoff, the same way for every provider
  });
  const model = currentModel(req.tier);
  try {
    const res = await anthropicClient.messages.create(
      {
        model,
        max_tokens: 1024,
        // Both system blocks are identical across calls in a country, so they are cached
        // (the breakpoint on the last one caches everything before it).
        system: req.system.map((text, i) => ({
          type: 'text' as const,
          text,
          ...(i === req.system.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
        })),
        messages: [{ role: 'user', content: req.user }],
        // Classification: low effort keeps latency down; the precise tier still thinks a little.
        output_config: { effort: 'low', format: zodOutputFormat(req.schema) },
        ...(req.tier === 'fast' ? { thinking: { type: 'disabled' as const } } : {}),
      },
      { timeout: TIMEOUT_MS[req.tier] },
    );
    if (res.stop_reason === 'refusal') throw new Error('model declined to score this transcript');
    return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      throw new HttpError(429, err.message, retryAfter(err.headers?.get?.('retry-after')));
    }
    if (err instanceof Anthropic.APIError && err.status) throw new HttpError(err.status, err.message);
    throw err;
  }
}

let geminiClient: GoogleGenAI | null = null;
async function gemini(req: Request): Promise<string> {
  geminiClient ??= new GoogleGenAI({ apiKey: config.llm.gemini.apiKey });
  try {
    const res = await geminiClient.models.generateContent({
      model: currentModel(req.tier),
      contents: req.user,
      config: {
        // Gemini caches repeated prompt prefixes implicitly; the system text is identical across calls.
        systemInstruction: req.system.join('\n\n'),
        responseMimeType: 'application/json',
        temperature: 0,
        httpOptions: { timeout: TIMEOUT_MS[req.tier] },
      },
    });
    return res.text ?? '';
  } catch (err: any) {
    if (typeof err?.status === 'number') throw new HttpError(err.status, err.message);
    throw err;
  }
}

const IMPL: Record<Provider, (req: Request) => Promise<string>> = { gemini, anthropic };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries HTTP 429 with exponential backoff + jitter (or the server's Retry-After). Other errors throw at once. */
async function withBackoff<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 429 || attempt >= RATE_LIMIT_RETRIES) throw err;
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      const wait = Math.min(BACKOFF_MAX_MS, err.retryAfterMs ?? backoff);
      log.warn('detector', `${label} rate limited (429), retry ${attempt + 1}/${RATE_LIMIT_RETRIES} in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
}

/** Sends one prompt to the provider chosen by LLM_PROVIDER and returns the raw text. */
export function complete(req: Request): Promise<string> {
  const p = currentProvider();
  return withBackoff(() => IMPL[p](req), `${p}/${req.tier}`);
}

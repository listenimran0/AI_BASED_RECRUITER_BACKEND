import OpenAI from 'openai';
import type { ZodType } from 'zod';
import { config, llmEnabled } from '../config';
import { log } from '../logger';
import { LlmUsage } from '../models';

export type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolDef = OpenAI.Chat.Completions.ChatCompletionTool;

export type UsageCtx = { purpose: string; jobId?: unknown; conversationId?: unknown };

let client: OpenAI | null = null;
function api() {
  if (!client) client = new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl });
  return client;
}

async function recordUsage(ctx: UsageCtx, usage?: { prompt_tokens?: number; completion_tokens?: number } | null) {
  if (!usage) return;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const costUsd = (promptTokens * config.llm.priceIn + completionTokens * config.llm.priceOut) / 1_000_000;
  try {
    await LlmUsage.create({
      jobId: ctx.jobId,
      conversationId: ctx.conversationId,
      purpose: ctx.purpose,
      model: config.llm.model,
      promptTokens,
      completionTokens,
      costUsd,
    });
  } catch (err) {
    log.warn({ err }, 'could not save llm usage');
  }
}

export async function chatWithTools(messages: Msg[], tools: ToolDef[], ctx: UsageCtx) {
  const res = await api().chat.completions.create({
    model: config.llm.model,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.2,
  });
  await recordUsage(ctx, res.usage);
  return res.choices[0].message;
}

type JsonCall<T> = {
  system: string;
  user: string;
  ctx: UsageCtx;
  fallback: () => T;
};

export function stripFences(text: string) {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) return m[1];
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start > 0 || (end !== -1 && end < t.length - 1) ? t.slice(start, end + 1) : t;
}

export async function completeJson<T>(schema: ZodType<T>, call: JsonCall<T>): Promise<T> {
  if (!llmEnabled) return call.fallback();

  const messages: Msg[] = [
    { role: 'system', content: `${call.system}\n\nRespond with a single JSON object and nothing else.` },
    { role: 'user', content: call.user },
  ];

  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await api().chat.completions.create({
      model: config.llm.model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });
    await recordUsage(call.ctx, res.usage);
    const text = res.choices[0].message.content || '';
    try {
      return schema.parse(JSON.parse(stripFences(text)));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: `That JSON was not valid for the schema (${lastError}). Send a corrected JSON object only.` });
    }
  }
  throw new Error(`Model returned invalid JSON: ${lastError.slice(0, 200)}`);
}

export async function completeText(system: string, user: string, ctx: UsageCtx, fallback: () => string) {
  if (!llmEnabled) return fallback();
  const res = await api().chat.completions.create({
    model: config.llm.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
  });
  await recordUsage(ctx, res.usage);
  return res.choices[0].message.content?.trim() || '';
}

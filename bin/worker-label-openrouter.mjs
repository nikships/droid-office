#!/usr/bin/env node
// Contract v1 example. Run with Node 22+; no npm dependencies.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function openRouterLabel(request, { key, fetchImpl = fetch }) {
  if (!key) throw new Error('Set OPENROUTER_API_KEY or pass --key-file /absolute/path.');
  if (
    request?.version !== 1 ||
    typeof request.system !== 'string' ||
    typeof request.conversation !== 'string' ||
    typeof request.model !== 'string' ||
    !request.model ||
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(request.effort) ||
    (request.previousSubject !== undefined && typeof request.previousSubject !== 'string')
  )
    throw new Error('Invalid contract v1 request or unsupported OpenRouter effort.');
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(40_000),
    body: JSON.stringify({
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: JSON.stringify({ conversation: request.conversation.slice(-24_000), previousSubject: request.previousSubject?.slice(0, 60) }) },
      ],
      reasoning: { effort: request.effort, exclude: true },
      max_tokens: 2048,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'worker_label',
          strict: true,
          schema: { type: 'object', properties: { name: { type: 'string' }, summary: { type: 'string' } }, required: ['name', 'summary'], additionalProperties: false },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}.`);
  const body = await response.json();
  const choice = body.choices?.[0];
  if (choice?.finish_reason !== 'stop' || choice.message?.tool_calls?.length || typeof choice.message?.content !== 'string') throw new Error('OpenRouter did not return a complete text label.');
  const label = JSON.parse(choice.message.content);
  if (typeof label?.name !== 'string' || !label.name.trim() || typeof label.summary !== 'string' || !label.summary.trim()) throw new Error('OpenRouter returned an invalid label.');
  return { name: label.name, summary: label.summary };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--key-file' || !path.isAbsolute(args[1]))) throw new Error('Usage: node worker-label-openrouter.mjs [--key-file /absolute/path]');
  const key = args.length ? (await readFile(args[1], 'utf8')).trim() : process.env.OPENROUTER_API_KEY;
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw new Error('Request exceeds 256 KiB.');
    chunks.push(chunk);
  }
  const label = await openRouterLabel(JSON.parse(Buffer.concat(chunks).toString('utf8')), { key });
  process.stdout.write(`${JSON.stringify(label)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never echo API responses, request text, credentials or filesystem errors.
    process.stderr.write('OpenRouter label generation failed. Check the key, model, effort and request format.\n');
    process.exitCode = 1;
  });
}

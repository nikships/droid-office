import { z } from 'zod';
import { AGENT_EFFORTS } from '../../shared/protocol.js';
import { PROMPT_IMAGE_ID, PROMPT_IMAGES_MAX } from '../../shared/drops.js';
import { DROID_MODEL_MAX, isValidDroidModel } from '../agents.js';

export const floorRef = z.string().trim().min(1).max(128).describe('Floor id, number, or name.');
export const workerRef = z.string().trim().min(1).max(64).describe('Worker id or name from office_roster.');
export const workerTarget = {
  worker: workerRef.optional().describe('Worker id or name from office_roster.'),
  workerId: workerRef.optional().describe('Alias for worker.'),
  name: workerRef.optional().describe('Alias for worker.'),
};
export const WORKER_TARGET_ERROR = 'Pass worker (or alias workerId/name), without conflicting values.';
export const PROMPT_TEXT_ERROR = 'Pass prompt or text, without conflicting values.';

export function resolveWorkerTarget(a: { worker?: string; workerId?: string; name?: string }): string | undefined {
  const vals = [a.worker, a.workerId, a.name].filter((v): v is string => v !== undefined);
  if (!vals.length) return undefined;
  const first = vals[0].toLowerCase();
  return vals.every((v) => v.toLowerCase() === first) ? vals[0] : undefined;
}

export function resolvePromptText(a: { prompt?: string; text?: string }): string | undefined {
  if (a.prompt !== undefined && a.text !== undefined && a.prompt !== a.text) return undefined;
  return a.prompt ?? a.text;
}
export const id = z.string().trim().min(1).max(1024);
export const text = z.string().max(20_000);
export const model = z.string().trim().min(1).max(DROID_MODEL_MAX).refine(isValidDroidModel, 'Model ids contain no whitespace or control characters.').describe('Exact model id from team_models.');
export const effort = z.enum(AGENT_EFFORTS).describe('Supported effort.');
export const images = z.array(z.string().regex(PROMPT_IMAGE_ID)).max(PROMPT_IMAGES_MAX).describe('Uploaded image ids.');

export const menu = z
  .strictObject({
    question: text.optional().describe('Displayed question.'),
    choices: z
      .array(
        z.strictObject({
          number: z.number().int().positive(),
          label: text,
          description: text.optional(),
          selected: z.boolean().optional(),
        }),
      )
      .min(1)
      .describe('Displayed options in order.'),
    pointer: z.number().int().nonnegative().optional().describe('Focused zero-based index.'),
    freeText: z.boolean().describe('Typed answers accepted.'),
    multiSelect: z.boolean().optional().describe('Checkbox multi-select.'),
    review: z.array(text).optional().describe('Review summary lines.'),
  })
  .describe('Exact AskUser menu snapshot (refused if changed; never for permission prompts).');

export const cloud = z
  .strictObject({
    computerId: id.optional().describe('Existing Factory computer id.'),
    environmentId: id.optional().describe('Factory environment id (may incur charges).'),
    cwd: z.string().min(1).max(4096).optional().describe('Remote working folder.'),
  })
  .refine((a) => Boolean(a.computerId) !== Boolean(a.environmentId), 'Choose exactly one computerId or environmentId.');

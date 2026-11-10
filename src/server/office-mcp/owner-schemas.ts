import { z } from 'zod';
import { AGENT_EFFORTS } from '../../shared/protocol.js';
import { PROMPT_IMAGE_ID, PROMPT_IMAGES_MAX } from '../../shared/drops.js';
import { DROID_MODEL_MAX, isValidDroidModel } from '../agents.js';

export const floorRef = z.string().trim().min(1).max(128).describe('Floor id, elevator number or name. Omit for the target worker’s floor.');
export const workerRef = z.string().trim().min(1).max(64).describe('Worker id or unambiguous name from office_roster. May target any worker, not only your subagents.');
export const id = z.string().trim().min(1).max(1024);
export const text = z.string().max(20_000);
export const model = z.string().trim().min(1).max(DROID_MODEL_MAX).refine(isValidDroidModel, 'Model ids contain no whitespace or control characters.').describe('Exact model id from team_models; must be available.');
export const effort = z.enum(AGENT_EFFORTS).describe('Reasoning effort supported by the selected model.');
export const images = z.array(z.string().regex(PROMPT_IMAGE_ID)).max(PROMPT_IMAGES_MAX).describe('Existing office-upload image ids, not paths or image bytes.');

export const menu = z
  .strictObject({
    question: text.optional().describe('Exact question currently shown.'),
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
      .describe('The currently displayed options, in order, with their original numbers and labels.'),
    pointer: z.number().int().nonnegative().optional().describe('Currently focused zero-based option.'),
    freeText: z.boolean().describe('Whether the displayed menu accepts a typed answer.'),
    multiSelect: z.boolean().optional().describe('Whether the displayed menu has checkboxes.'),
  })
  .describe('Exact menu snapshot from the worker’s screen. The server refuses an answer if the menu changed.');

export const cloud = z
  .strictObject({
    computerId: id.optional().describe('Existing Factory computer id. Choose this or environmentId, not both.'),
    environmentId: id.optional().describe('Factory environment id; starts a computer for this worker, which may incur charges.'),
    cwd: z.string().min(1).max(4096).optional().describe('Working folder on that remote computer; omit for its home.'),
  })
  .refine((a) => Boolean(a.computerId) !== Boolean(a.environmentId), 'Choose exactly one computerId or environmentId.');

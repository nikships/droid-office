import { z } from 'zod';
import { AGENT_EFFORTS, SUBAGENT_MAX_PER_LEAD, SUBAGENT_MODELS_MAX, SUBAGENT_MODEL_NOTE_MAX } from '../../shared/protocol.js';
import { LABEL_EFFORTS } from '../../shared/worker-labels.js';
import { checkPictureSource, FRAMES } from '../../shared/decor.js';
import { SUBSCRIPTION_PROVIDERS } from '../../shared/subscriptions.js';
import { PROMPT_IMAGE_ID, PROMPT_IMAGES_MAX } from '../../shared/drops.js';
import { DROID_MODEL_MAX, isValidDroidModel } from '../agents.js';
import { labelSettings as validLabelSettings } from '../worker-label-settings.js';

export const floorRef = z.string().trim().min(1).max(128).describe('Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor.');
export const workerRef = z.string().trim().min(1).max(64).describe('Worker id or unambiguous name from office_roster. May target any worker, not only your subagents.');
export const id = z.string().trim().min(1).max(1024);
export const text = z.string().max(20_000);
export const model = z.string().trim().min(1).max(DROID_MODEL_MAX).refine(isValidDroidModel, 'Model ids contain no whitespace or control characters.').describe('Exact model id from models_list; must be available.');
export const effort = z.enum(AGENT_EFFORTS).describe('Reasoning effort supported by the selected model.');
export const choice = z.strictObject({ model: model.optional(), effort: effort.optional() });
export const provider = z.enum(SUBSCRIPTION_PROVIDERS).describe('Subscription provider.');
export const images = z.array(z.string().regex(PROMPT_IMAGE_ID)).max(PROMPT_IMAGES_MAX).describe('Existing office-upload image ids, not paths or image bytes.');
export const repo = id.optional().describe('Another repository of this worker’s multi-repository workspace; omit for its own.');

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

export const subagentSettings = z
  .strictObject({
    officeMcp: z.boolean().describe('False immediately disables this MCP connection as well as local workers’ access.'),
    on: z.boolean().describe('Allow local workers to hire subagents.'),
    deskWorkers: z.boolean().describe('Allow local desk workers, not just station leads, to hire.'),
    agent: choice.optional().describe('Default subagent model and effort; omit to inherit the office default.'),
    models: z
      .array(z.strictObject({ id: model, note: z.string().max(SUBAGENT_MODEL_NOTE_MAX).optional() }))
      .min(1)
      .max(SUBAGENT_MODELS_MAX)
      .refine((models) => new Set(models.map((m) => m.id)).size === models.length, 'Each model id must be unique.')
      .optional()
      .describe('Allowed local subagent models with routing notes; omit for unrestricted.'),
    worktree: z.boolean().describe('Default to isolated worktrees for subagents.'),
    maxPerLead: z.number().int().min(1).max(SUBAGENT_MAX_PER_LEAD).describe('Local lead’s maximum team size.'),
    wakeLead: z.boolean().describe('Wake resting leads when their teams have news.'),
    visits: z.boolean().describe('Enable visits between independent workers.'),
    denyTask: z.boolean().describe('Direct local workers to Office hiring instead of the built-in Task tool.'),
  })
  .describe('Complete replacement of the office-wide Subagents settings, not a patch.');

export const labelSettings = z
  .strictObject({
    on: z.boolean(),
    implementation: z.enum(['droid', 'custom']).optional().describe('Custom runs an executable as the owner; omitted uses Droid.'),
    command: z.string().max(4096).optional().describe('Absolute executable path on the office machine for custom labels.'),
    args: z.array(z.string()).optional().describe('Literal executable arguments, not a shell command.'),
    model,
    effort: z.enum(LABEL_EFFORTS),
    intervalSeconds: z.number().int().min(15).max(3600).describe('Seconds between label refreshes, 15 to 3600.'),
  })
  .refine((value) => validLabelSettings(value) !== undefined, 'Custom labels require an absolute executable path and at most 32 literal arguments, without control characters.')
  .describe('Complete replacement of worker-label settings. A custom executable runs with the owner’s permissions.');

export const decor = z.strictObject({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => !('error' in checkPictureSource(value)), 'Use an HTTP(S) image URL or an existing upload reference.')
    .describe('HTTP(S) image URL or existing upload:<hash>.<extension> reference.'),
  title: z.string().max(80).optional(),
  wall: z.enum(['north', 'south', 'east', 'west']),
  u: z.number().describe('Horizontal center along the wall in meters.'),
  y: z.number().describe('Center height in meters.'),
  w: z.number().positive().describe('Image width in meters.'),
  h: z.number().positive().describe('Image height in meters.'),
  frame: z
    .number()
    .int()
    .min(0)
    .max(FRAMES.length - 1)
    .describe(`Frame index: ${FRAMES.map((frame, i) => `${i} ${frame.name}`).join(', ')}.`),
});

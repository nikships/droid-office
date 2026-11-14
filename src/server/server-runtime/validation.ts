import { PROMPT_IMAGES_MAX, PROMPT_IMAGE_ID } from '../../shared/drops.js';

export const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
/** Which of a worker's repositories a Changes message is about: another floor's (see WorkerInfo.repos), or none for its own. */
export const repoOf = (v: unknown) => str(v, 64) || undefined;
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Prompt pictures in insertion order, well-formed, unique, and within the prompt limit. */
export const imageIds = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, 16)).filter((x) => PROMPT_IMAGE_ID.test(x)))].slice(0, PROMPT_IMAGES_MAX) : []);

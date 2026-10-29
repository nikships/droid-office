/** Keep an empty draft to one touch row; grow written text only, with room left for the thread. */
export function composerInputHeight(text: string, contentHeight: number, compact: boolean): number {
  if (!text || !Number.isFinite(contentHeight)) return 44;
  return Math.min(compact ? 80 : 128, Math.max(44, Math.ceil(contentHeight)));
}

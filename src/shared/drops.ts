// Files dropped or pasted into a droid's terminal: the browser sends them to the office, which keeps
// them on its own machine (see server/drops.ts), and the terminal types where they are, as a terminal
// does with a file dragged into it. Droid turns a pasted picture's path into an image.

/** The biggest file that can be dropped into a terminal: plenty for a screenshot of a big screen. */
export const DROP_MAX_BYTES = 25 * 1024 * 1024;

/** The most pictures one prompt can carry. */
export const PROMPT_IMAGES_MAX = 10;

/** The kinds of picture a prompt takes. */
export const PROMPT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** What a picture kept for a prompt is called until the prompt is sent: the id its upload answers with. */
export const PROMPT_IMAGE_ID = /^[0-9a-f]{16}$/;

/**
 * A prompt with the pictures it carries listed after it, numbered in the order they were added, so
 * "image 2" means what the person who wrote it saw as 2. With no text the list is the whole prompt.
 */
export function withImages(text: string, paths: string[]): string {
  const clean = text.trim();
  if (!paths.length) return clean;
  const list = paths.map((p, i) => `Image ${i + 1}: ${p}`).join('\n');
  return clean ? `${clean}\n\n${list}` : list;
}

/**
 * What a terminal types for files dragged into it, one path after another: a Windows path in quotes
 * when it has spaces, any other with a backslash before each character a shell would split it on.
 */
export function droppedPaths(paths: string[]): string {
  return paths.map((p) => (/^[a-z]:[\\/]/i.test(p) ? (/\s/.test(p) ? `"${p}"` : p) : p.replace(/[^\p{L}\p{N}_@%+=:,./-]/gu, '\\$&'))).join(' ');
}

import { mergeMessages, resultsByCall, toolLine, type FactoryBlock, type FactoryMessage } from '../../shared/factory-sessions';
import { FactoryFetchError, factoryFetch } from '../factory';
import { h } from './dom';
import { markdown } from './markdown';

// A Droid session's transcript, as Factory keeps it (GET /api/factory/sessions/:id/messages):
// user and assistant text as markdown, thinking folded away, each tool call one line that opens
// onto its input and result, and pictures as thumbnails. It pages back through older messages,
// and while the session runs it reads the newest every few seconds and follows the bottom. The
// Sessions window mounts it, and so does a cloud droid's window.

export interface TranscriptOptions {
  sessionId: string;
  /** Whether the session runs now: while it does, the transcript reads new messages every few seconds. Read at every tick. */
  live?: () => boolean;
  /** Messages per page (1-100). */
  pageSize?: number;
  /**
   * Whether the session was only just made: Factory 404s one for a few seconds, so while this says so
   * a 404 reads as starting (and is tried again every few seconds) instead of an error.
   */
  starting?: () => boolean;
  /** What to say while it has no messages (default "No messages yet"). Read at every paint. */
  empty?: () => string;
}

export interface Transcript {
  /** The scrolling transcript: put it where it can grow (it's a flex column of its own). */
  element: HTMLElement;
  /** Reads the newest messages now, and follows the bottom (after sending one, say). */
  refresh(): Promise<void>;
  /** Stops reading; call it when its window closes. */
  dispose(): void;
}

/** While the session runs, the newest messages are read this often. */
const LIVE_MS = 3000;
/** After it stops running, the newest are read until its reply is in, for at most this long. */
const SETTLE_MS = 90_000;
/** How near the bottom (px) still counts as at the bottom, so new messages scroll into view. */
const STICK_PX = 80;

interface Page {
  messages: FactoryMessage[];
  hasMore: boolean;
  nextCursor?: string;
}

type ToolResult = Extract<FactoryBlock, { type: 'tool_result' }>;

function image(b: Extract<FactoryBlock, { type: 'image' }>): HTMLElement {
  if (!b.data) return h('span.ft-noimg', {}, '🖼️ picture (too big to show)');
  const img = h('img.ft-img', { src: `data:${b.mediaType};base64,${b.data}`, alt: 'Picture', loading: 'lazy', title: 'Click to enlarge' });
  img.addEventListener('click', () => img.classList.toggle('big'));
  return img;
}

function resultBody(r: ToolResult | undefined): HTMLElement {
  if (!r) return h('div.ft-pending', {}, '…waiting for the result');
  return h('pre.ft-result', { class: r.isError ? 'error' : '' }, r.text || (r.images ? `${r.images} picture${r.images === 1 ? '' : 's'}` : '(no output)'));
}

function toolCall(b: Extract<FactoryBlock, { type: 'tool_use' }>, r: ToolResult | undefined): HTMLElement {
  const input = Object.keys(b.input).length ? JSON.stringify(b.input, null, 2) : '';
  return h(
    'details.ft-tool',
    { class: r?.isError ? 'error' : r ? 'done' : 'running' },
    h('summary', {}, h('span.ft-tool-mark', {}, r?.isError ? '✖' : r ? '✓' : '…'), h('span.ft-tool-line', {}, toolLine(b.name, b.input))),
    input ? h('pre.ft-input', {}, input) : null,
    resultBody(r),
  );
}

/** One message as nodes. Tool results show under their call; one whose call isn't loaded shows by itself. */
export function renderMessage(m: FactoryMessage, results: Map<string, ToolResult>, calls: Set<string>): HTMLElement | null {
  const parts: HTMLElement[] = [];
  for (const b of m.blocks) {
    if (b.type === 'text') parts.push(m.role === 'tool' ? h('pre.ft-result', {}, b.text) : markdown(b.text));
    else if (b.type === 'thinking') parts.push(h('details.ft-think', {}, h('summary', {}, 'Thinking'), h('div.ft-think-text', {}, b.text)));
    else if (b.type === 'tool_use') parts.push(toolCall(b, results.get(b.id)));
    else if (b.type === 'tool_result') {
      if (calls.has(b.toolUseId)) continue;
      parts.push(h('details.ft-tool', { class: b.isError ? 'error' : 'done' }, h('summary', {}, h('span.ft-tool-mark', {}, b.isError ? '✖' : '✓'), h('span.ft-tool-line', {}, 'Result')), resultBody(b)));
    } else if (b.type === 'image') parts.push(image(b));
    else if (b.type === 'document') parts.push(h('span.ft-doc', {}, `📎 ${b.name}`));
  }
  if (!parts.length) return null;
  const who = m.role === 'user' ? 'You' : m.role === 'tool' ? 'Tool' : 'Droid';
  return h(
    'div.ft-msg',
    { class: `${m.role}${m.isError ? ' error' : ''}`, 'data-id': m.id },
    h('div.ft-who', {}, who, m.createdAt ? h('time', { datetime: new Date(m.createdAt).toISOString() }, new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null),
    ...parts,
  );
}

/** What a message's rendering depends on: it, and whether each of its calls has its result yet. */
const signature = (m: FactoryMessage, results: Map<string, ToolResult>, calls: Set<string>) =>
  `${m.id}|${m.blocks.length}|${m.blocks.map((b) => (b.type === 'tool_use' ? (results.has(b.id) ? 'r' : '-') : b.type === 'tool_result' ? (calls.has(b.toolUseId) ? 'c' : '-') : b.type[0])).join('')}`;

export function mountTranscript(opts: TranscriptOptions): Transcript {
  const limit = opts.pageSize ?? 30;
  const path = `/${encodeURIComponent(opts.sessionId)}/messages`;
  const older = h('button.btn.ft-older.hidden', { type: 'button' }, 'Load earlier messages');
  const status = h('div.ft-status', {}, 'Reading the transcript…');
  const list = h('div.ft-list');
  const element = h('div.ft', { role: 'log', 'aria-label': 'Transcript', 'aria-live': 'polite' }, older, list, status);

  let messages: FactoryMessage[] = [];
  let cursor: string | undefined;
  let hasMore = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<void> | undefined;
  const nodes = new Map<string, { sig: string; node: HTMLElement | null }>();

  const atBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;

  const paint = (stick: boolean) => {
    const results = resultsByCall(messages);
    const calls = new Set<string>();
    for (const m of messages) for (const b of m.blocks) if (b.type === 'tool_use') calls.add(b.id);
    const want: HTMLElement[] = [];
    const keep = new Set<string>();
    for (const m of messages) {
      const sig = signature(m, results, calls);
      let had = nodes.get(m.id);
      if (!had || had.sig !== sig) {
        // Re-rendered when one of its calls got its result: keep the ones you'd opened open.
        const open = had?.node ? [...had.node.querySelectorAll('details')].map((d) => d.open) : [];
        const node = renderMessage(m, results, calls);
        if (node && open.length) node.querySelectorAll('details').forEach((d, i) => (d.open = open[i] ?? false));
        had = { sig, node };
        nodes.set(m.id, had);
      }
      keep.add(m.id);
      if (had.node) want.push(had.node);
    }
    for (const id of nodes.keys()) if (!keep.has(id)) nodes.delete(id);
    // Only what moved is touched, so a scrolled-to spot and open details stay put.
    let at = list.firstElementChild;
    for (const node of want) {
      if (at === node) {
        at = at.nextElementSibling;
        continue;
      }
      list.insertBefore(node, at);
    }
    while (at) {
      const next = at.nextElementSibling;
      at.remove();
      at = next;
    }
    older.classList.toggle('hidden', !hasMore);
    status.textContent = messages.length ? '' : (opts.empty?.() ?? 'No messages yet');
    status.classList.remove('error');
    if (stick) element.scrollTop = element.scrollHeight;
  };

  /** The last read was a just-made session's 404: read again at the next tick, live or not. */
  let unborn = false;
  const fail = (err: unknown) => {
    unborn = err instanceof FactoryFetchError && err.status === 404 && !messages.length && !!opts.starting?.();
    if (unborn) {
      status.textContent = 'Starting… Factory is getting the session ready';
      status.classList.remove('error');
      return;
    }
    status.textContent = `Couldn’t read the transcript: ${(err as Error).message}`;
    status.classList.add('error');
  };

  /** The newest page, merged in. A page that shares nothing with what's loaded starts over from it. */
  const readNewest = async () => {
    const stick = !messages.length || atBottom();
    const page = await factoryFetch<Page>('sessions', path, { query: { limit } });
    if (disposed) return;
    unborn = false;
    const known = new Set(messages.map((m) => m.id));
    if (!messages.length || !page.messages.some((m) => known.has(m.id))) {
      messages = page.messages;
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    } else messages = mergeMessages(messages, page.messages);
    paint(stick);
  };

  // A read asked for while one is on its way runs after it: the one on its way may have left before
  // what the caller wants to see (the reply to a message just sent) was there.
  let next: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (reading) {
      next ??= reading.then(() => {
        next = undefined;
        return refresh();
      });
      return next;
    }
    reading = readNewest()
      .catch(fail)
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };

  const loadOlder = async () => {
    if (!cursor) return;
    older.setAttribute('disabled', '');
    older.textContent = 'Loading…';
    try {
      const page = await factoryFetch<Page>('sessions', path, { query: { limit, cursor } });
      if (disposed) return;
      // Keep the message you were looking at where it was.
      const before = element.scrollHeight - element.scrollTop;
      messages = mergeMessages(page.messages, messages);
      cursor = page.nextCursor;
      hasMore = page.hasMore;
      paint(false);
      element.scrollTop = element.scrollHeight - before;
    } catch (err) {
      fail(err);
    } finally {
      older.removeAttribute('disabled');
      older.textContent = 'Load earlier messages';
    }
  };
  older.addEventListener('click', () => void loadOlder());

  // While it runs: the newest every few seconds, and after it stops until its last words are in:
  // Factory lists a message many seconds after it was made, and says the session is idle before then.
  const lastReply = () => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return messages[i].id;
    return '';
  };
  let settleUntil = 0;
  let settleFrom = '';
  let wasLive = false;
  const tick = () => {
    if (disposed) return;
    const live = opts.live?.() ?? false;
    if (wasLive && !live) {
      settleUntil = Date.now() + SETTLE_MS;
      settleFrom = lastReply();
    }
    // A reply newer than the one there was when it stopped, and nothing after it: that's its answer.
    if (settleUntil && messages.at(-1)?.role === 'assistant' && lastReply() !== settleFrom) settleUntil = 0;
    if ((live || Date.now() < settleUntil || unborn) && !document.hidden) void refresh();
    wasLive = live;
    timer = setTimeout(tick, LIVE_MS);
  };
  void refresh().then(() => {
    timer = setTimeout(tick, LIVE_MS);
  });

  return {
    element,
    refresh,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

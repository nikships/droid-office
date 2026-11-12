// Server-side deep link bounce (`/open/...`) and MCP enrichment helpers. `/open/...` is a public
// zero-state bootstrap route like `/dashboard`: it never reads or discloses office state or tokens,
// and bounces Android browsers straight into Droid Office (`droidoffice://open/...`) via an Android
// `intent://` redirect with a self-hosted fallback card when the app isn't installed or on desktop.

import type http from 'node:http';
import { androidIntentDeepLink, appDeepLink, cardDeepLink, deepLinkPathAndQuery, floorDeepLink, normalizeDeepLinkBase, parseDeepLink, questionDeepLink, workerDeepLink, type DeepLinkTarget } from '../shared/deep-links.js';
import { COMPANION_PATH } from '../shared/devices.js';

const ANDROID_APK_RELEASES = 'https://github.com/nikships/droid-office/releases/latest';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function companionHref(target: DeepLinkTarget): string {
  if (target.kind === 'worker' || target.kind === 'question') {
    const params = [`worker=${encodeURIComponent(target.workerId)}`];
    if (target.floorId) params.push(`floor=${encodeURIComponent(target.floorId)}`);
    if (target.kind === 'question' || target.view === 'thread') params.push('view=thread');
    return `${COMPANION_PATH}#${params.join('&')}`;
  }
  return COMPANION_PATH;
}

function targetSummary(target: DeepLinkTarget): { eyebrow: string; title: string; detail: string } {
  switch (target.kind) {
    case 'worker':
      return {
        eyebrow: 'WORKER TERMINAL',
        title: `Open worker ${target.workerId}`,
        detail: target.floorId ? `Floor ${target.floorId} · Live terminal in Droid Office` : 'Live terminal in Droid Office',
      };
    case 'floor':
      return {
        eyebrow: 'OFFICE FLOOR',
        title: `Open floor ${target.floorId}`,
        detail: 'Switch to this floor in Droid Office',
      };
    case 'card':
      return {
        eyebrow: 'WHITEBOARD CARD',
        title: `Open card ${target.cardId}`,
        detail: target.floorId ? `Floor ${target.floorId} · Live Whiteboard card` : 'Live Whiteboard card in Droid Office',
      };
    case 'question':
      return {
        eyebrow: 'PENDING QUESTION',
        title: `Answer ${target.workerId}`,
        detail: target.floorId ? `Floor ${target.floorId} · Waiting for your answer` : 'Waiting for your answer in Droid Office',
      };
  }
}

const HOST_HEADER_RE = /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/;

function requestOrigin(req: http.IncomingMessage, scheme: 'http' | 'https', fallbackBase?: string): string | undefined {
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
  if (host && HOST_HEADER_RE.test(host)) {
    const candidate = normalizeDeepLinkBase(`${scheme}://${host}`);
    if (candidate) return candidate;
  }
  return normalizeDeepLinkBase(fallbackBase);
}

export function serveDeepLinkBounce(req: http.IncomingMessage, res: http.ServerResponse, rawUrl: string, scheme: 'http' | 'https', fallbackBase?: string): void {
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...headers, 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' });
    res.end(JSON.stringify({ error: 'Use GET or HEAD' }));
    return;
  }

  const base = requestOrigin(req, scheme, fallbackBase);
  const fullUrl = `${base ?? 'http://invalid.local'}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(fullUrl);
  } catch {
    res.writeHead(400, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad request.');
    return;
  }

  const parsed = parseDeepLink(parsedUrl.toString());
  if (!parsed) {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Invalid Droid Office link.');
    return;
  }

  const { target, officeId } = parsed;
  const effectiveBase = normalizeDeepLinkBase(parsedUrl.searchParams.get('u')) ?? base;
  const ua = String(req.headers['user-agent'] ?? '');
  const stay = parsedUrl.searchParams.get('stay') === '1';

  if (/\bAndroid\b/i.test(ua) && !stay && base) {
    const fallbackUrl = `${base}${deepLinkPathAndQuery(target, { base: effectiveBase, office: officeId, stay: true })}`;
    const location = androidIntentDeepLink(target, { base: effectiveBase, office: officeId, fallbackUrl });
    res.writeHead(302, { ...headers, location });
    res.end();
    return;
  }

  const appHref = appDeepLink(target, { base: effectiveBase, office: officeId });
  const webHref = companionHref(target);
  const info = targetSummary(target);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(info.title)} · Droid Office</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0b;color:#f4f4f5;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px}main{width:100%;max-width:420px;background:#121215;border:1px solid #27272c;border-radius:6px;padding:24px}.eyebrow{font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;color:#ff6a00;margin:0 0 8px}h1{font-size:20px;line-height:1.25;margin:0 0 6px;word-break:break-word}p{margin:0 0 20px;color:#a1a1aa;font-size:14px}.actions{display:grid;gap:10px}a.btn{display:flex;align-items:center;justify-content:center;min-height:44px;padding:10px 16px;border-radius:4px;text-decoration:none;font-weight:600;font-size:14px}a.primary{background:#ff6a00;color:#0a0a0b}a.secondary{background:#1a1a1f;color:#f4f4f5;border:1px solid #2e2e35}.foot{margin:16px 0 0;font-size:12px;color:#71717a}a.link{color:#a1a1aa}</style></head><body><main><div class="eyebrow">DROID OFFICE · ${escapeHtml(info.eyebrow)}</div><h1>${escapeHtml(info.title)}</h1><p>${escapeHtml(info.detail)}</p><div class="actions"><a class="btn primary" href="${escapeHtml(appHref)}">Open in Droid Office app</a><a class="btn secondary" href="${escapeHtml(webHref)}">Open web companion</a></div><p class="foot">Need the Android app? <a class="link" href="${ANDROID_APK_RELEASES}">Download the latest APK</a>, pair once with your office QR code, and tap this link again.</p></main></body></html>`;
  res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
  res.end(req.method === 'HEAD' ? undefined : html);
}

export { workerDeepLink, floorDeepLink, cardDeepLink, questionDeepLink };

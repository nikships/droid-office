const ALPHA_NUM_RE = /[A-Za-z0-9]/;

export interface WorkspacePathRef {
  path: string;
  displayPath?: string;
  line?: number;
  column?: number;
  endLine?: number;
}

export interface WorkspacePathMatch extends WorkspacePathRef {
  raw: string;
  start: number;
  end: number;
}

const KNOWN_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'py',
  'pyi',
  'kt',
  'kts',
  'java',
  'rs',
  'go',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'm',
  'mm',
  'swift',
  'cs',
  'rb',
  'php',
  'lua',
  'r',
  'scala',
  'clj',
  'dart',
  'zig',
  'nim',
  'sql',
  'graphql',
  'gql',
  'proto',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'gradle',
  'xml',
  'plist',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'svg',
  'md',
  'mdx',
  'rst',
  'txt',
  'tex',
  'patch',
  'diff',
  'lock',
  'vue',
  'svelte',
  'astro',
  'prisma',
  'dockerfile',
  'mk',
  'cmake',
  'glsl',
  'wgsl',
  'metal',
  'entitlements',
]);

const KNOWN_EXTENSIONLESS_BASENAMES = new Set(['Dockerfile', 'Containerfile', 'Makefile', 'GNUmakefile', 'Procfile', 'Gemfile', 'Podfile', 'Fastfile', 'Brewfile', 'LICENSE', 'CODEOWNERS']);

const KNOWN_ROOT_FILES = new Set([
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'LICENSE',
  'Makefile',
  'Dockerfile',
  'package.json',
  'package-lock.json',
  'biome.jsonc',
  '.oxlintrc.json',
  '.env.example',
  '.droid-office.json',
  'vite.config.ts',
  'vite.config.js',
  'electron-builder.yml',
  'firebase.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.server.json',
  'tsconfig.client.json',
  'tsconfig.desktop.json',
  'tsconfig.desktop-page.json',
  'Cargo.toml',
  'Cargo.lock',
  'pyproject.toml',
  'go.mod',
  'go.sum',
  'build.gradle.kts',
  'settings.gradle.kts',
]);

const DOMAIN_TLD_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|org|net|io|ai|dev|app|co|gg|sh|rs|py|js|ts|edu|gov|mil|me|tv|xyz|info|biz|tech|cloud|site|online|page|link|so|to|fm|uk|de|fr|jp|ca|au|in|ch|nl|se|no|es|it|br|us|eu)(?::\d+)?$/i;
const HOST_PORT_OR_IP_RE = /^(?:localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)$/i;

// Candidate token: optional ./ prefix, path characters, and optional :line(-endLine|:col) or #Lline(-LendLine).
const PATH_CANDIDATE_RE = /(?:\.\/)?[A-Za-z0-9_.][A-Za-z0-9_./-]*[A-Za-z0-9_](?:(?::\d+(?:-\d+|:\d+)?)|(?:#L\d+(?:-L?\d+)?))?/g;

function hasValidFileLeaf(base: string): boolean {
  if (!base || base === '.' || base === '..') return false;
  if (KNOWN_EXTENSIONLESS_BASENAMES.has(base) || KNOWN_ROOT_FILES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return KNOWN_EXTENSIONS.has(ext);
}

function validateWorkspacePathCandidate(rawToken: string, allowBareRootFile: boolean): WorkspacePathRef | null {
  let work = rawToken;
  let line: number | undefined;
  let endLine: number | undefined;

  const hashMatch = /#L(\d+)(?:-L?(\d+))?$/i.exec(work);
  if (hashMatch) {
    line = Number(hashMatch[1]);
    if (hashMatch[2]) endLine = Math.max(line, Number(hashMatch[2]));
    work = work.slice(0, hashMatch.index);
  } else {
    const colonMatch = /:(\d+)(?:-(\d+)|:(\d+))?$/.exec(work);
    if (colonMatch) {
      line = Number(colonMatch[1]);
      if (colonMatch[2]) endLine = Math.max(line, Number(colonMatch[2]));
      work = work.slice(0, colonMatch.index);
    }
  }

  if (line !== undefined && (!Number.isFinite(line) || line < 1)) return null;

  const hadDotSlash = work.startsWith('./');
  const cleanPath = hadDotSlash ? work.slice(2) : work;
  if (!cleanPath || cleanPath.startsWith('/') || cleanPath.endsWith('/')) return null;
  if (cleanPath.includes('//')) return null;

  const parts = cleanPath.split('/');
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') return null;
  }

  if (parts.length === 1) {
    // Root-level file: require known repo root filename AND (:line or ./prefix or inline-code context).
    if (!KNOWN_ROOT_FILES.has(cleanPath)) return null;
    if (!hadDotSlash && line === undefined && !allowBareRootFile) return null;
  } else {
    const firstSeg = parts[0];
    if (HOST_PORT_OR_IP_RE.test(firstSeg) || DOMAIN_TLD_RE.test(firstSeg)) return null;
    const leaf = parts[parts.length - 1];
    if (!hasValidFileLeaf(leaf)) return null;
  }

  const ref: WorkspacePathRef = { path: cleanPath };
  if (line !== undefined) ref.line = line;
  if (endLine !== undefined && endLine >= (line ?? 1)) ref.endLine = endLine;
  return ref;
}

/**
 * Matches workspace-relative file paths (`src/foo/bar.ts`, `src/foo/bar.ts:42-51`, `README.md:12`)
 * in `text`, excluding URLs (`://`, `mailto:`), `@mentions`, domain names (`factory.ai`, `github.com`),
 * absolute paths, and `..` segments.
 */
export function parseWorkspacePathRefs(text: string): WorkspacePathMatch[] {
  if (!text) return [];
  const matches: WorkspacePathMatch[] = [];
  PATH_CANDIDATE_RE.lastIndex = 0;

  for (let m = PATH_CANDIDATE_RE.exec(text); m; m = PATH_CANDIDATE_RE.exec(text)) {
    const start = m.index;
    const raw = m[0];
    const end = start + raw.length;

    // Check preceding context to exclude URLs (://, mailto:), @mentions/@scopes, ~/home, or absolute /paths.
    if (start > 0) {
      const prev = text[start - 1];
      if (prev === '@' || prev === '/' || prev === '~' || prev === '$' || prev === '#' || ALPHA_NUM_RE.test(prev)) continue;
      if (prev === ':') {
        const beforeColon = text.slice(Math.max(0, start - 12), start).toLowerCase();
        if (/[a-z][a-z0-9+.-]*:$/.test(beforeColon)) continue;
      }
    }

    // Check trailing context so `github.com` inside `github.com:443` or URL query strings aren't split weirdly.
    if (end < text.length) {
      const next = text[end];
      if (next === '@' || ALPHA_NUM_RE.test(next)) continue;
      if (raw && text.slice(end, end + 3) === '://') continue;
    }

    const validated = validateWorkspacePathCandidate(raw, false);
    if (!validated) continue;

    matches.push({
      raw,
      start,
      end,
      ...validated,
    });
  }

  return matches;
}

const CODE_PATH_MAX = 512;
const CODE_PATH_CHARS_RE = /^[A-Za-z0-9._@+~ /-]+$/;
export const CODE_PATH_LINE_RE = /:(\d+)(?::(\d+)|[-–](\d+))?$/;

/**
 * Factory's test for an inline code span that names a file (`src/a.ts`, `README.md:12`,
 * `src/a.ts:4-9`, `src/a.ts:4:2`, `/abs/path/a.ts`), as the path and lines to open, or null.
 * Bare names count only for known repository root files, since there is no file search to find them.
 */
export function codePathRef(text: string): WorkspacePathRef | null {
  const t = text.trim().replace(/\\/g, '/');
  if (!t || t.length > CODE_PATH_MAX || /[^\S ]/.test(t) || t.includes('  ') || /( \/)|(\/ )/.test(t) || t.includes('://')) return null;
  const m = CODE_PATH_LINE_RE.exec(t);
  let path = m ? t.slice(0, m.index) : t;
  const line = m ? Number(m[1]) : undefined;
  const endLine = m?.[3] !== undefined ? Number(m[3]) : undefined;
  if (line !== undefined && line < 1) return null;
  if (path.startsWith('./')) path = path.slice(2);
  if (!path || !CODE_PATH_CHARS_RE.test(path) || path.startsWith('//') || path.endsWith('/') || path.startsWith('~') || path.startsWith('@')) return null;
  const absolute = path.startsWith('/');
  const parts = (absolute ? path.slice(1) : path).split('/');
  if (parts.some((seg) => !seg || seg === '.' || seg === '..' || seg !== seg.trim())) return null;
  const leaf = parts[parts.length - 1];
  if (parts.length === 1) {
    if (absolute || !KNOWN_ROOT_FILES.has(leaf)) return null;
  } else {
    if (!absolute && (HOST_PORT_OR_IP_RE.test(parts[0]) || DOMAIN_TLD_RE.test(parts[0]))) return null;
    if (!hasValidFileLeaf(leaf)) return null;
  }
  const ref: WorkspacePathRef = { path };
  if (line !== undefined) ref.line = line;
  if (line !== undefined && endLine !== undefined && endLine >= line) ref.endLine = endLine;
  return ref;
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function balanced(text: string, open: string, close: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === open) depth++;
    else if (ch === close && --depth < 0) return false;
  }
  return depth === 0;
}

/** Terminal tokens are only candidates. The host must confirm every file before it becomes a link. */
export function terminalPathRef(raw: string): WorkspacePathRef | null {
  let text = raw.trim().replace(/[.,;!?]+$/, '');
  while (text.length >= 2 && PAIRS[text[0]] === text[text.length - 1] && balanced(text.slice(1, -1), text[0], text[text.length - 1])) {
    text = text.slice(1, -1);
  }
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'" || text[0] === '`') && text.indexOf(text[0], 1) === text.length - 1) {
    text = text.slice(1, -1);
  }
  text = text.replace(/^[<{]+/, '').replace(/[>}]+$/, '');
  let line: number | undefined;
  let column: number | undefined;
  let endLine: number | undefined;
  const hashSuffix = /#L(\d+)(?:-L?(\d+))?$/i.exec(text);
  const colonSuffix = !hashSuffix ? /:(\d+)(?::(\d+)|-(\d+))?:?$/.exec(text) : null;
  if (hashSuffix) {
    line = Number(hashSuffix[1]);
    if (hashSuffix[2]) endLine = Number(hashSuffix[2]);
    text = text.slice(0, hashSuffix.index);
  } else if (colonSuffix) {
    line = Number(colonSuffix[1]);
    if (colonSuffix[2]) column = Number(colonSuffix[2]);
    if (colonSuffix[3]) endLine = Number(colonSuffix[3]);
    text = text.slice(0, colonSuffix.index);
  }
  text = text.replace(/:$/, '').replace(/^["'`]+|["'`]+$/g, '');
  if (/^file:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.hostname && url.hostname !== 'localhost') return null;
      text = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  if (!text || text.length > 4096 || /[\0\r\n]/.test(text) || text.includes('://')) return null;
  if (text.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith('@')) return null;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return null;
  if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < (line ?? 1))) return null;
  if (!text.includes('/') && !/^[\w.+-]+\.[\w+-]+$/.test(text) && !KNOWN_ROOT_FILES.has(text)) return null;
  const ref: WorkspacePathRef = { path: text };
  if (line !== undefined) ref.line = line;
  if (column !== undefined) ref.column = column;
  if (endLine !== undefined) ref.endLine = endLine;
  return ref;
}

export function parseTerminalPathRefs(text: string): WorkspacePathMatch[] {
  const matches: WorkspacePathMatch[] = [];
  // Quoted paths may contain spaces; unquoted tokens keep route brackets such as app/(auth)/[id]/page.tsx intact.
  const tokens = /"[^"\r\n]+"(?::\d+(?::\d+|-\d+)?)?|'[^'\r\n]+'(?::\d+(?::\d+|-\d+)?)?|`[^`\r\n]+`(?::\d+(?::\d+|-\d+)?)?|[^\s"'`<>]+/g;
  for (const match of text.matchAll(tokens)) {
    let start = match.index;
    let end = start + match[0].length;
    if (/^["'`]/.test(match[0])) {
      while (start < end && /[.,;!?]/.test(text[end - 1])) end--;
      const quote = text[start];
      if (end - start >= 2 && text[end - 1] === quote && text.indexOf(quote, start + 1) === end - 1) {
        start++;
        end--;
      }
    } else {
      const mdLink = text.slice(start, end).indexOf('](');
      if (mdLink >= 0) start += mdLink + 2;
      while (start < end) {
        if (/[.,;!?]/.test(text[end - 1])) {
          end--;
          continue;
        }
        const open = text[start];
        const close = PAIRS[open];
        if (close && end - start >= 2 && text[end - 1] === close && balanced(text.slice(start + 1, end - 1), open, close)) {
          start++;
          end--;
          continue;
        }
        if (close && !balanced(text.slice(start, end), open, close)) {
          start++;
          continue;
        }
        const matchOpen = CLOSERS[text[end - 1]];
        if (matchOpen && !balanced(text.slice(start, end), matchOpen, text[end - 1])) {
          end--;
          continue;
        }
        break;
      }
      const current = text.slice(start, end);
      // ripgrep may put matching source immediately after the location, without whitespace.
      if (!current.includes('://')) {
        const rg = /^(.+?:\d+(?::\d+|-\d+)?)(?=:(?!\d))/.exec(current);
        if (rg) end = start + rg[1].length;
      }
    }
    const raw = text.slice(start, end);
    const ref = terminalPathRef(raw);
    if (!ref) continue;
    matches.push({ ...ref, raw, start, end });
  }
  return matches;
}

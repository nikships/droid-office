import test from 'node:test';
import assert from 'node:assert/strict';
import { cardFormat } from '../src/shared/whiteboard.js';
import { FACTORY_ARTIFACT_CSS, FACTORY_HTML_STARTER, FACTORY_LOGOS, FACTORY_TOKENS, GUIDE_TOPICS, formatWhiteboardGuide } from '../src/shared/whiteboard-design.js';
import { extractMarkdownTitle, formatMediaTimestamp, markdownReferences, parseTimecodeTokens, renderImageArtifact, renderMarkdownArtifact, renderVideoArtifact } from '../src/shared/whiteboard-markdown.js';

const HASH = 'a'.repeat(64);

test('Factory design tokens, official brand SVGs, CSS starter and guide topics stay complete', () => {
  assert.equal(FACTORY_TOKENS.dark.background, '#020202');
  assert.equal(FACTORY_TOKENS.dark.accent, '#EE6018');
  assert.equal(FACTORY_TOKENS.light.background, '#F5F5F5');
  assert.equal(FACTORY_TOKENS.light.accentDeep, '#D15010');
  assert.match(FACTORY_ARTIFACT_CSS, /width:\s*1280px/);
  assert.match(FACTORY_ARTIFACT_CSS, /data-wb-ping-state="sent"/);
  assert.match(FACTORY_HTML_STARTER, /data-wb-id=/);
  const logoEntries = Object.values(FACTORY_LOGOS);
  assert.equal(logoEntries.length, 6);
  for (const logo of logoEntries) {
    assert.match(logo.svg, /^<svg[\s>]/, logo.file);
    assert.match(logo.svg, /viewBox="/, logo.file);
  }
  for (const topic of GUIDE_TOPICS) {
    const text = formatWhiteboardGuide(topic);
    assert.ok(text.length > 150, topic);
  }
  assert.match(formatWhiteboardGuide('tokens'), /#EE6018/);
  assert.match(formatWhiteboardGuide('css'), /--accent/);
  assert.match(formatWhiteboardGuide('interactive'), /data-wb-ping/);
  assert.match(formatWhiteboardGuide('artifacts'), /markdownFile/);
  assert.match(formatWhiteboardGuide('brand'), /exportLogosTo/);
});

test('Markdown artifact builder handles frontmatter, numbered sections, index rail, tables, callouts, checklists and safe escaping', () => {
  const md = `---
owner: SRE
theme: light
---

# Rollout Spec

Intro paragraph with \`inlineCode()\` and [docs](https://factory.ai), ![chart](./metrics.png) and <script>alert(1)</script>.

> [!WARNING]
> Hold traffic at 5% until p99 settles.

## Architecture
- [x] Ship edge router
- [ ] Verify canary metrics

## Rollout gates
| Gate | Target | Owner |
| :--- | :---: | ---: |
| Latency p99 | <= 120ms | Core |
| Error rate | < 0.1% | SRE |

## Sign-off
\`\`\`ts
const ready = true;
\`\`\`

\`\`\`wb-actions
[{"action":"approve","label":"Approve rollout","ping":"Approved RFC 042 — proceed with rollout.","primary":true},{"action":"hold","label":"Hold for review"}]
\`\`\`
`;

  assert.equal(extractMarkdownTitle(md), 'Rollout Spec');
  assert.deepEqual(markdownReferences(md), ['./metrics.png']);

  const html = renderMarkdownArtifact(md, { title: 'Rollout Spec' });
  assert.match(html, /data-theme="light"/);
  assert.match(html, /owner: SRE/);
  assert.match(html, /Rollout Spec/);
  // 3 H2 sections produce numbered Factory eyebrows and the sticky index rail.
  assert.match(html, /01/);
  assert.match(html, /02/);
  assert.match(html, /03/);
  assert.match(html, /class="md-rail"/);
  // Callouts, aligned GFM tables, interactive task checkboxes with progress badge, copy Markdown, lightbox, and ping buttons.
  assert.match(html, /WARN/);
  assert.match(html, /text-align:\s*center/);
  assert.match(html, /text-align:\s*right/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /id="wb-task-progress"[^>]*>1\/2 DONE</);
  assert.match(html, /id="wb-copy-md"/);
  assert.match(html, /id="wb-md-src"/);
  assert.match(html, /id="wb-lightbox"/);
  assert.match(html, /position:\s*sticky/);
  assert.match(html, /data-wb-action="approve"/);
  assert.match(html, /data-wb-ping="Approved RFC 042 — proceed with rollout\."/);
  // Raw script tags in Markdown prose are escaped, never injected.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('Markdown inline autolinking, <br> line breaks, and loose checklists render cleanly', () => {
  const md = `# Links & Loose Lists

Visit (https://factory.ai/docs) or https://en.wikipedia.org/wiki/Factory_(object-oriented_programming), and line one<br>line two.

- [x] First loose task

- [ ] Second loose task
  with continuation text

> Quoted note
---
`;
  const html = renderMarkdownArtifact(md, { title: 'Links & Loose Lists' });
  assert.match(html, /\(<a href="https:\/\/factory\.ai\/docs" target="_blank" rel="noopener noreferrer">https:\/\/factory\.ai\/docs<\/a>\)/);
  assert.match(html, /<a href="https:\/\/en\.wikipedia\.org\/wiki\/Factory_\(object-oriented_programming\)" target="_blank" rel="noopener noreferrer">https:\/\/en\.wikipedia\.org\/wiki\/Factory_\(object-oriented_programming\)<\/a>,/);
  assert.match(html, /line one<br>line two/);
  assert.match(html, /Second loose task with continuation text/);
  assert.match(html, /<hr class="wb-rule">/);
});

test('Video and Image artifact builders emit 1280px Factory surfaces with fullscreen controls, stable anchors and timecode helpers', () => {
  const videoHtml = renderVideoArtifact({
    title: 'Walkthrough clip',
    videoSrc: 'video.mp4',
    videoMime: 'video/mp4',
    posterSrc: 'poster.png',
    caption: '60 fps capture from isolated clone',
    sizeBytes: 2 * 1024 * 1024,
  });
  assert.match(videoHtml, /id="vid-player"/);
  assert.match(videoHtml, /data-wb-id="video"/);
  assert.match(videoHtml, /var SRC = "video\.mp4"/);
  assert.match(videoHtml, /poster="poster\.png"/);
  assert.match(videoHtml, /id="v-fs"/);
  assert.match(videoHtml, /requestFullscreen/);
  assert.match(videoHtml, /id="v-hover-time"/);
  assert.match(videoHtml, /id="vid-overlay"/);
  assert.match(videoHtml, /id="v-dl"[^>]*download="Walkthrough clip\.mp4"/);
  assert.match(videoHtml, /PIN @TIME/);
  assert.match(videoHtml, /whiteboard\.on\('seek'/);
  assert.match(videoHtml, /60 fps capture from isolated clone/);

  const imageHtml = renderImageArtifact({
    title: 'Diagram',
    imageSrc: 'image.svg',
    imageMime: 'image/svg+xml',
    caption: 'System topology',
    theme: 'light',
  });
  assert.match(imageHtml, /data-theme="light"/);
  assert.match(imageHtml, /data-wb-id="image" src="image\.svg"/);
  assert.match(imageHtml, /id="img-fs"/);
  assert.match(imageHtml, /id="img-fs-exit"/);
  assert.match(imageHtml, /LIGHT BG/);
  assert.match(imageHtml, /GRID BG/);
  assert.match(imageHtml, /id="img-dl"[^>]*download="Diagram\.svg"/);
  assert.match(imageHtml, /System topology/);

  assert.equal(formatMediaTimestamp(0), '@00:00.0');
  assert.equal(formatMediaTimestamp(-4), '@00:00.0');
  assert.equal(formatMediaTimestamp(0.999), '@00:01.0');
  assert.equal(formatMediaTimestamp(59.96), '@01:00.0');
  assert.equal(formatMediaTimestamp(3723.4), '@1:02:03.4');

  const parts = parseTimecodeTokens('See @01:24, (@12.5s), @1:02:03, and user@example.com').filter((p) => p.kind === 'timecode');
  assert.deepEqual(parts, [
    { kind: 'timecode', text: '@01:24', seconds: 84 },
    { kind: 'timecode', text: '@12.5s', seconds: 12.5 },
    { kind: 'timecode', text: '@1:02:03', seconds: 3723 },
  ]);
});

test('cardFormat honours explicit format and infers legacy markdown, video, image, html and canvas cards', () => {
  assert.equal(cardFormat({ kind: 'canvas' }), 'canvas');
  assert.equal(cardFormat({ kind: 'html' }), 'html');
  assert.equal(cardFormat({ kind: 'html', content: { entry: 'index.html', format: 'video', files: {} } }), 'video');
  assert.equal(
    cardFormat({
      kind: 'html',
      content: {
        entry: 'index.html',
        files: {
          'index.html': { hash: HASH, size: 10, mime: 'text/html' },
          'document.md': { hash: HASH, size: 5, mime: 'text/markdown' },
        },
      },
    }),
    'markdown',
  );
  assert.equal(
    cardFormat({
      kind: 'html',
      content: {
        entry: 'index.html',
        files: {
          'index.html': { hash: HASH, size: 10, mime: 'text/html' },
          'video.webm': { hash: HASH, size: 50, mime: 'video/webm' },
        },
      },
    }),
    'video',
  );
  assert.equal(
    cardFormat({
      kind: 'html',
      content: {
        entry: 'index.html',
        files: {
          'index.html': { hash: HASH, size: 10, mime: 'text/html' },
          'image.svg': { hash: HASH, size: 20, mime: 'image/svg+xml' },
        },
      },
    }),
    'image',
  );
});

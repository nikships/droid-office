import { useState } from 'react';
import { Check, Copy, Download, X } from 'lucide-react';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { CodeBlock } from '../CodeBlock';
import { Reveal } from './Reveal';
import { SectionHeader } from './SectionHeader';
import { devCommands, macSteps, requirements } from '../../data/install';
import { DROID_CLI_URL, RELEASES_URL } from '../../data/links';

type CopyState = 'idle' | 'copied' | 'error';

export function InstallSection() {
  const [copy, setCopy] = useState<CopyState>('idle');

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(devCommands);
      setCopy('copied');
    } catch {
      setCopy('error');
    }
    window.setTimeout(() => setCopy('idle'), 1800);
  };

  return (
    <section id="install" className="scroll-mt-14 border-b border-line" aria-labelledby="install-title">
      <div className="mx-auto max-w-[1240px] px-6 py-24">
        <Reveal>
          <SectionHeader id="install-title" index="06" label="Install" title="Get started in a minute." />
        </Reveal>

        <div className="mt-14 grid gap-4 lg:grid-cols-2">
          <Reveal className="flex flex-col rounded-[6px] border border-line bg-bg-panel">
            <div className="flex items-center justify-between border-b border-line px-6 py-4">
              <h3 className="font-body text-[18px] font-medium text-text">Mac app</h3>
              <Badge tone="green">Supported</Badge>
            </div>
            <div className="flex flex-1 flex-col p-6">
              <ol className="space-y-3">
                {macSteps.map((step, i) => (
                  <li key={step} className="flex gap-4 text-[15px] leading-[1.55] text-text-dim">
                    <span className="font-heading text-[11px] tabular-nums leading-[2] text-accent">{String(i + 1).padStart(2, '0')}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>

              <div className="mt-8 rounded-[4px] border border-line">
                <p className="border-b border-line px-4 py-2.5 font-heading text-[10px] font-semibold uppercase tracking-[0.16em] text-text-dim">You need</p>
                <ul className="divide-y divide-line-faint">
                  {requirements.map((r) => (
                    <li key={r.name} className="flex items-center justify-between gap-4 px-4 py-2.5">
                      <span className="font-heading text-[12px] text-text">{r.name}</span>
                      <span className="text-[13px] text-text-dim">{r.note}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-auto flex flex-wrap items-center gap-3 pt-8">
                <Button variant="primary" className="!text-[#020202] hover:!bg-white hover:!text-[#020202]" onClick={() => window.open(RELEASES_URL, '_blank', 'noopener')}>
                  <Download size={14} aria-hidden />
                  Download .dmg
                </Button>
                <Button variant="ghost" onClick={() => window.open(DROID_CLI_URL, '_blank', 'noopener')}>
                  Get the Droid CLI
                </Button>
              </div>
              <p className="mt-3 font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">Apple Silicon · the only supported production install</p>
            </div>
          </Reveal>

          <Reveal delay={0.08} className="flex flex-col rounded-[6px] border border-line bg-bg-panel">
            <div className="flex items-center justify-between border-b border-line px-6 py-4">
              <h3 className="font-body text-[18px] font-medium text-text">From source</h3>
              <Badge tone="neutral">Developers</Badge>
            </div>
            <div className="flex flex-1 flex-col p-6">
              <p className="text-[15px] leading-[1.55] text-text-dim">Run, modify or experiment with the code. Needs Node.js 20+ and the same tools as the Mac app.</p>
              <div className="relative mt-6">
                <CodeBlock className="!p-5 !text-[13px] !leading-[1.8] !text-text">{devCommands}</CodeBlock>
                <div className="absolute right-2 top-2">
                  <Button size="sm" variant="ghost" onClick={onCopy} aria-label="Copy commands">
                    {copy === 'copied' ? <Check size={12} aria-hidden /> : copy === 'error' ? <X size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    {copy === 'copied' ? 'Copied' : copy === 'error' ? 'Failed' : 'Copy'}
                  </Button>
                </div>
              </div>
              <p className="mt-4 text-[14px] text-text-dim">
                Then open <span className="selectable font-heading text-[13px] text-text">http://localhost:5173</span>.
              </p>
              <p className="mt-auto pt-8 text-[13px] text-text-dim">A developer checkout, not a production install. No command-line installers or standalone server releases.</p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

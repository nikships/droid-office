import { Download, GitFork } from 'lucide-react';
import { Button } from '../Button';
import { Logo } from '../Logo';
import { GITHUB_URL, RELEASES_URL, UPSTREAM_URL } from '../../data/links';

export function SiteFooter() {
  return (
    <footer>
      <div className="mx-auto max-w-[1240px] px-6 py-24">
        <div className="flex flex-col items-start justify-between gap-8 md:flex-row md:items-end">
          <h2 className="max-w-[16ch] font-body text-[40px] font-medium leading-[1.05] tracking-[-0.03em] text-text md:text-[60px]">
            Give your agents a desk<span className="text-accent">.</span>
          </h2>
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" className="!text-[#020202] hover:!bg-white hover:!text-[#020202]" onClick={() => window.open(RELEASES_URL, '_blank', 'noopener')}>
              <Download size={14} aria-hidden />
              Download for Mac
            </Button>
            <Button onClick={() => window.open(GITHUB_URL, '_blank', 'noopener')}>
              <GitFork size={14} aria-hidden />
              Star on GitHub
            </Button>
          </div>
        </div>
      </div>

      <div className="border-t border-line">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-3 px-6 py-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2.5 text-text-dim">
            <Logo size={14} />
            <span className="font-heading text-[10px] uppercase tracking-[0.1em]">Droid Office · MIT license</span>
          </div>
          <p className="text-[13px] text-text-dim">
            Began as a fork of{' '}
            <a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className="text-text underline decoration-line-strong underline-offset-4 transition-colors duration-[120ms] hover:text-accent-bright">
              AgentSystemLabs/agent-office
            </a>
            , whose authors built the office, desks, terminals and boards.
          </p>
        </div>
      </div>
    </footer>
  );
}

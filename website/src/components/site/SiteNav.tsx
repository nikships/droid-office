import { Download, GitFork } from 'lucide-react';
import { Button } from '../Button';
import { Logo } from '../Logo';
import { GITHUB_URL, RELEASES_URL, navLinks } from '../../data/links';

export function SiteNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg-void">
      <div className="mx-auto flex h-14 max-w-[1240px] items-center justify-between gap-4 px-6">
        <a href="#top" className="flex items-center gap-2.5 text-text" aria-label="Droid Office home">
          <Logo size={18} />
          <span className="font-heading text-[12px] font-semibold uppercase tracking-[0.1em]">Droid Office</span>
        </a>

        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          {navLinks.map((link) => (
            <a key={link.href} href={link.href} className="rounded-[3px] px-3 py-1.5 font-heading text-[11px] uppercase tracking-[0.08em] text-text-dim transition-colors duration-[120ms] hover:text-accent-bright">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => window.open(GITHUB_URL, '_blank', 'noopener')}>
            <GitFork size={13} aria-hidden />
            <span className="hidden sm:inline">GitHub</span>
          </Button>
          <Button variant="primary" size="sm" className="!text-[#020202] hover:!bg-white hover:!text-[#020202]" onClick={() => window.open(RELEASES_URL, '_blank', 'noopener')}>
            <Download size={13} aria-hidden />
            Download
          </Button>
        </div>
      </div>
    </header>
  );
}

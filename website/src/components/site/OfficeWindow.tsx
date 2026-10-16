import { motion } from 'framer-motion';
import { images } from '../../data/links';

type Callout = {
  label: string;
  color: string;
  left: string;
  top: string;
};

const callouts: Callout[] = [
  { label: 'desk 04 · auth refactor', color: 'var(--accent)', left: '47%', top: '22%' },
  { label: 'desk 09 · reviewing !231', color: 'var(--accent)', left: '63%', top: '41%' },
  { label: 'desk 12 · shipped', color: 'var(--green)', left: '41%', top: '58%' },
];

const counts = [
  { label: 'working', value: 6, color: 'var(--accent)' },
  { label: 'shipped', value: 3, color: 'var(--green)' },
];

export function OfficeWindow() {
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-bg-panel">
      <div className="flex h-10 items-center justify-between gap-4 border-b border-line px-4 font-heading text-[10px] uppercase tracking-[0.1em]">
        <div className="flex items-center gap-3 text-text-dim">
          <span className="flex gap-1.5" aria-hidden>
            <span className="h-2 w-2 rounded-full border border-line-strong" />
            <span className="h-2 w-2 rounded-full border border-line-strong" />
            <span className="h-2 w-2 rounded-full border border-line-strong" />
          </span>
          <span className="hidden sm:inline">Droid Office</span>
          <span className="text-text-faint" aria-hidden>
            /
          </span>
          <span className="text-text">floor 3 · web-app</span>
        </div>
        <ul className="flex items-center gap-4" aria-label="Worker status">
          {counts.map((c) => (
            <li key={c.label} className="flex items-center gap-1.5 text-text-dim">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.color }} aria-hidden />
              <span className="tabular-nums text-text">{c.value}</span>
              <span className="hidden md:inline">{c.label}</span>
            </li>
          ))}
          <li className="hidden rounded-[3px] border border-line px-1.5 py-0.5 text-text-dim lg:block">⌘K</li>
        </ul>
      </div>

      <div className="relative">
        <img src={images.hero} alt="A cutaway of the office building at night: five floors of desks with AI workers at glowing terminals, a glass elevator on the side and a rooftop" className="block aspect-[3/2] w-full object-cover" />

        {callouts.map((c, i) => (
          <motion.span
            key={c.label}
            className="absolute hidden items-center gap-1.5 rounded-[3px] border bg-bg-void px-2 py-1 font-heading text-[10px] font-semibold uppercase tracking-[0.08em] text-text md:flex"
            style={{ left: c.left, top: c.top, borderColor: c.color }}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.6 + i * 0.25, ease: [0.4, 0, 0.2, 1] }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.color }} aria-hidden />
            {c.label}
          </motion.span>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">
        <span>Five floors, one per project</span>
        <span className="hidden sm:inline">Elevator · fire pole · rooftop</span>
      </div>
    </div>
  );
}

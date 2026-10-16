import { Factory, GitMerge, KanbanSquare, Sparkles, type LucideIcon } from 'lucide-react';
import { Reveal } from './Reveal';
import { SectionHeader } from './SectionHeader';
import { guests, stats, whyPoints } from '../../data/why';
const icons: Record<string, LucideIcon> = {
  droid: Sparkles,
  gitlab: GitMerge,
  jira: KanbanSquare,
  factory: Factory,
};
export function WhySection() {
  return (
    <section id="why" className="scroll-mt-14 border-b border-line" aria-labelledby="why-title">
      <div className="mx-auto max-w-[1240px] px-6 py-24">
        <Reveal>
          <SectionHeader id="why-title" index="04" label="Why Droid Office" title="Built for teams that live in Factory." lede="It started as a fork of agent-office and went its own way: Droid first, GitLab and Jira on the wall." />
        </Reveal>

        <div className="mt-14 grid gap-px overflow-hidden rounded-[6px] border border-line bg-line md:grid-cols-2">
          {whyPoints.map((point, i) => {
            const Icon = icons[point.id] ?? Sparkles;
            return (
              <Reveal key={point.id} delay={i * 0.05} className="bg-bg-panel p-7 md:p-9">
                <div className="flex items-center gap-3">
                  <Icon size={16} className="text-accent" aria-hidden />
                  <h3 className="font-body text-[20px] font-medium tracking-[-0.01em] text-text">{point.title}</h3>
                </div>
                <p className="mt-3 max-w-[48ch] text-[15px] leading-[1.6] text-text-dim">{point.body}</p>
              </Reveal>
            );
          })}
        </div>

        <Reveal className="mt-4 flex flex-col gap-4 rounded-[6px] border border-line bg-bg-panel p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-heading text-[10px] font-semibold uppercase tracking-[0.16em] text-text-dim">Guests welcome</p>
            <p className="mt-1 text-[14px] text-text-dim">Agents you start in a terminal get a desk too, and can be brought in.</p>
          </div>
          <ul className="flex flex-wrap gap-2">
            {guests.map((g) => (
              <li key={g} className="rounded-[3px] border border-line-strong bg-bg-raised px-2.5 py-1 font-heading text-[11px] text-text">
                {g}
              </li>
            ))}
          </ul>
        </Reveal>

        <dl className="mt-16 grid grid-cols-2 border-t border-line lg:grid-cols-4">
          {stats.map((stat, i) => (
            <Reveal key={stat.label} delay={i * 0.05} className={`border-b border-line py-8 pr-4 lg:border-b-0 ${i > 0 ? 'lg:border-l lg:pl-8' : ''} ${i % 2 === 1 ? 'border-l pl-6 lg:pl-8' : ''}`}>
              <dd className="font-heading text-[40px] font-medium tabular-nums leading-none tracking-[-0.02em] text-text md:text-[52px]">{stat.value}</dd>
              <dt className="mt-3 font-heading text-[10px] uppercase tracking-[0.12em] text-text-dim">{stat.label}</dt>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}

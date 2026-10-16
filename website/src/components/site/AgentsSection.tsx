import { CircleDot, Compass, GitPullRequest, Workflow, type LucideIcon } from 'lucide-react';
import { Eyebrow } from '../Eyebrow';
import { AutoHealLog } from './AutoHealLog';
import { Reveal } from './Reveal';
import { SectionHeader } from './SectionHeader';
import { VideoPlaceholder } from './VideoPlaceholder';
import { autoHealVideo, boardAgents, teamLeadVideo } from '../../data/agents';
const icons: Record<string, LucideIcon> = {
  issues: CircleDot,
  pr: GitPullRequest,
  pipeline: Workflow,
  lead: Compass,
};
export function AgentsSection() {
  return (
    <section id="agents" className="scroll-mt-14 border-b border-line" aria-labelledby="agents-title">
      <div className="mx-auto max-w-[1240px] px-6 py-24">
        <Reveal>
          <SectionHeader id="agents-title" index="03" label="Agents" title="Kiosks by every board. A lead for the big jobs." lede="Board agents stand beside the walls they manage. Ask them, or hand the work to a worker at a desk." />
        </Reveal>

        <div className="mt-14 grid gap-px overflow-hidden rounded-[6px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {boardAgents.map((agent, i) => {
            const Icon = icons[agent.id] ?? CircleDot;
            return (
              <Reveal key={agent.id} delay={i * 0.05} className="flex flex-col bg-bg-panel p-6">
                <div className="flex items-center justify-between">
                  <span className="flex h-9 w-9 items-center justify-center rounded-[4px] border border-line-strong bg-bg-raised text-text">
                    <Icon size={16} aria-hidden />
                  </span>
                  <span className="font-heading text-[10px] uppercase tracking-[0.08em] text-text-dim">{agent.tool}</span>
                </div>
                <h3 className="mt-6 font-body text-[19px] font-medium tracking-[-0.01em] text-text">{agent.name}</h3>
                <p className="mt-1 font-heading text-[10px] uppercase tracking-[0.1em] text-accent">{agent.station}</p>
                <p className="mt-3 text-[14px] leading-[1.55] text-text-dim">{agent.body}</p>
                <ul className="mt-5 space-y-2 border-t border-line pt-4">
                  {agent.does.map((d) => (
                    <li key={d} className="flex items-center gap-2.5 text-[13px] text-text">
                      <span className="h-px w-3 bg-line-strong" aria-hidden />
                      {d}
                    </li>
                  ))}
                </ul>
              </Reveal>
            );
          })}
        </div>

        <div className="mt-20 grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:items-start">
          <Reveal>
            <Eyebrow index="03.1">Auto-heal</Eyebrow>
            <h3 className="mt-4 font-body text-[28px] font-medium leading-[1.15] tracking-[-0.02em] text-text md:text-[34px]">A red run wakes the Pipeline agent.</h3>
            <p className="mt-4 text-[16px] leading-[1.6] text-text-dim">
              Turn on Auto-heal for a floor. When a run on that floor fails, the Pipeline agent finds the root cause and hires a worker to push the fix. You see it happen on the wall.
            </p>
            <div className="mt-8">
              <VideoPlaceholder video={autoHealVideo} />
            </div>
          </Reveal>
          <Reveal delay={0.08} className="lg:sticky lg:top-20">
            <AutoHealLog />
          </Reveal>
        </div>

        <div className="mt-20 grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <Reveal className="order-2 lg:order-1">
            <VideoPlaceholder video={teamLeadVideo} />
          </Reveal>
          <Reveal delay={0.08} className="order-1 lg:order-2">
            <Eyebrow index="03.2">Team lead</Eyebrow>
            <h3 className="mt-4 font-body text-[28px] font-medium leading-[1.15] tracking-[-0.02em] text-text md:text-[34px]">One job in. Real workers out.</h3>
            <p className="mt-4 text-[16px] leading-[1.6] text-text-dim">Hire a lead at the Team kiosk. It splits the job, hires up to eight subagents to real desks, and reviews their reports before calling it done.</p>
            <dl className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-line bg-line">
              <div className="bg-bg-panel p-4">
                <dt className="font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">Default</dt>
                <dd className="mt-1 font-heading text-[24px] tabular-nums text-text">4</dd>
              </div>
              <div className="bg-bg-panel p-4">
                <dt className="font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">Max subagents</dt>
                <dd className="mt-1 font-heading text-[24px] tabular-nums text-text">8</dd>
              </div>
            </dl>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

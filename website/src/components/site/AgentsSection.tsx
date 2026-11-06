import { Eyebrow } from '../Eyebrow';
import { Reveal } from './Reveal';
import { SectionHeader } from './SectionHeader';
export function AgentsSection() {
  return (
    <section id="agents" className="scroll-mt-14 border-b border-line" aria-labelledby="agents-title">
      <div className="mx-auto max-w-[1240px] px-6 py-24">
        <Reveal>
          <SectionHeader id="agents-title" index="03" label="Agents" title="Every worker can lead a team." lede="Hand a big job to an ordinary worker. It can hire subagents at nearby desks, each with its own terminal." />
        </Reveal>

        <div className="mt-14 max-w-[720px]">
          <Reveal>
            <Eyebrow index="03.1">Worker teams</Eyebrow>
            <h3 className="mt-4 font-body text-[28px] font-medium leading-[1.15] tracking-[-0.02em] text-text md:text-[34px]">One job in. Real workers out.</h3>
            <p className="mt-4 text-[16px] leading-[1.6] text-text-dim">
              An ordinary worker splits the job, hires up to eight subagents to real desks through the Office MCP, and reviews their reports. Subagents do their assigned work and report back; they cannot hire subagents of their own.
            </p>
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

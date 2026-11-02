import { Cloud, Laptop, Network, type LucideIcon } from 'lucide-react';
import { Badge, BadgeDot } from '../Badge';
import { Eyebrow } from '../Eyebrow';
import { Reveal } from './Reveal';
import { SectionHeader } from './SectionHeader';
import { hookSignals, officeTools, runsOn, todoDemo } from '../../data/workers';
const icons: Record<string, LucideIcon> = {
  local: Laptop,
  cloud: Cloud,
  tailnet: Network,
};
export function WorkersSection() {
  const progress = todoDemo.done / todoDemo.total;
  return (
    <section id="workers" className="scroll-mt-14 border-b border-line" aria-labelledby="workers-title">
      <div className="mx-auto max-w-[1240px] px-6 py-24">
        <Reveal>
          <SectionHeader
            id="workers-title"
            index="04"
            label="Workers"
            title="Every worker, wherever it runs."
            lede="A desk on this Mac, a Factory computer or a bot on your tailnet. They all sit in the same office, and you can see what each one is doing from across the room."
          />
        </Reveal>

        <div className="mt-14 grid gap-px overflow-hidden rounded-[6px] border border-line bg-line md:grid-cols-3">
          {runsOn.map((place, i) => {
            const Icon = icons[place.id] ?? Laptop;
            return (
              <Reveal key={place.id} delay={i * 0.05} className="flex flex-col bg-bg-panel p-6">
                <div className="flex items-center justify-between">
                  <span className="flex h-9 w-9 items-center justify-center rounded-[4px] border border-line-strong bg-bg-raised text-text">
                    <Icon size={16} aria-hidden />
                  </span>
                  <span className="font-heading text-[10px] uppercase tracking-[0.08em] text-text-dim">{place.tool}</span>
                </div>
                <h3 className="mt-6 font-body text-[19px] font-medium tracking-[-0.01em] text-text">{place.name}</h3>
                <p className="mt-1 font-heading text-[10px] uppercase tracking-[0.1em] text-accent">{place.where}</p>
                <p className="mt-3 text-[14px] leading-[1.55] text-text-dim">{place.body}</p>
                <ul className="mt-5 space-y-2 border-t border-line pt-4">
                  {place.does.map((d) => (
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
            <Eyebrow index="04.1">Hooks</Eyebrow>
            <h3 className="mt-4 font-body text-[28px] font-medium leading-[1.15] tracking-[-0.02em] text-text md:text-[34px]">Workers tell you how it’s going.</h3>
            <p className="mt-4 text-[16px] leading-[1.6] text-text-dim">
              Droid’s own hooks carry each worker’s status, the question it’s waiting on and its todo list straight to the office. A working Droid shows how far through its list it is over its head, in the web companion and on your phone.
            </p>
          </Reveal>
          <Reveal delay={0.08} className="flex flex-col rounded-[6px] border border-line bg-bg-panel">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="font-heading text-[10px] font-semibold uppercase tracking-[0.16em] text-text-dim">Task card · {todoDemo.desk}</span>
              <Badge tone="accent">
                <BadgeDot spinning />
                working
              </Badge>
            </div>
            <div className="border-b border-line px-4 py-5">
              <p className="font-heading text-[11px] uppercase tracking-[0.08em] text-text-dim">{todoDemo.worker}</p>
              <p className="mt-1 text-[17px] font-medium text-text">{todoDemo.title}</p>
              <div className="mt-4 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={todoDemo.total} aria-valuenow={todoDemo.done} aria-label="Todo progress">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
                </div>
                <span className="font-heading text-[12px] tabular-nums text-text">
                  {todoDemo.done}/{todoDemo.total}
                </span>
              </div>
              <p className="mt-2 text-[13px] text-text-dim">
                <span className="font-heading text-[11px] uppercase tracking-[0.06em] text-text">Now · </span>
                {todoDemo.now}
              </p>
            </div>
            <ul className="divide-y divide-line-faint">
              {hookSignals.map((s) => (
                <li key={s.name} className="flex items-baseline justify-between gap-4 px-4 py-3">
                  <span className="font-heading text-[12px] uppercase tracking-[0.06em] text-text">{s.name}</span>
                  <span className="text-right text-[13px] text-text-dim">{s.note}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        <div className="mt-20 grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <Reveal className="order-2 rounded-[6px] border border-line bg-bg-panel lg:order-1">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="font-heading text-[10px] font-semibold uppercase tracking-[0.16em] text-text-dim">MCP server · droid-office</span>
              <span className="font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">Streamable HTTP</span>
            </div>
            <ul className="divide-y divide-line-faint">
              {officeTools.map((t) => (
                <li key={t.name} className="flex items-baseline justify-between gap-4 px-4 py-3">
                  <span className="font-heading text-[12px] text-text">{t.name}</span>
                  <span className="text-right text-[13px] text-text-dim">{t.note}</span>
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={0.08} className="order-1 lg:order-2">
            <Eyebrow index="04.2">Office MCP</Eyebrow>
            <h3 className="mt-4 font-body text-[28px] font-medium leading-[1.15] tracking-[-0.02em] text-text md:text-[34px]">One MCP server for the whole office.</h3>
            <p className="mt-4 text-[16px] leading-[1.6] text-text-dim">
              Workers hire subagents, visit each other and use the Whiteboard through one MCP server, in place of the old office commands and skills. Each worker sees only the tools it may use, and one switch in Settings turns it off.
            </p>
            <dl className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-line bg-line">
              <div className="bg-bg-panel p-4">
                <dt className="font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">Worker tools</dt>
                <dd className="mt-1 font-heading text-[24px] tabular-nums text-text">14</dd>
              </div>
              <div className="bg-bg-panel p-4">
                <dt className="font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">Tailnet bot tools</dt>
                <dd className="mt-1 font-heading text-[24px] tabular-nums text-text">+4</dd>
              </div>
            </dl>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

import { Eye, Gamepad2, LayoutGrid, type LucideIcon } from 'lucide-react';
import { Reveal } from './Reveal';
import { SectionHeader } from './SectionHeader';
import { VideoFrame } from './VideoFrame';
import { images } from '../../data/links';
import { funThings, pillars, playVideo } from '../../data/play';
const icons: Record<string, LucideIcon> = {
  fun: Gamepad2,
  spatial: Eye,
  glance: LayoutGrid,
};
export function PlaySection() {
  return (
    <section id="play" className="scroll-mt-14 border-b border-line" aria-labelledby="play-title">
      <div className="mx-auto max-w-[1240px] px-6 py-24">
        <Reveal>
          <SectionHeader
            id="play-title"
            index="01"
            label="Why 3D"
            title="Work you can walk around in."
            lede="Droid Office isn’t another terminal multiplexer. It’s a place. Your agents sit at desks in a 3D office and you run the team by walking the floor. It’s great for visual thinkers, and it’s a lot of fun."
          />
        </Reveal>

        <div className="mt-14 grid gap-px overflow-hidden rounded-[6px] border border-line bg-line md:grid-cols-3">
          {pillars.map((pillar, i) => {
            const Icon = icons[pillar.id] ?? Gamepad2;
            return (
              <Reveal key={pillar.id} delay={i * 0.06} className="bg-bg-panel p-7">
                <span className="flex h-9 w-9 items-center justify-center rounded-[4px] border border-line-strong bg-bg-raised text-accent">
                  <Icon size={16} aria-hidden />
                </span>
                <h3 className="mt-6 font-body text-[20px] font-medium tracking-[-0.01em] text-text">{pillar.title}</h3>
                <p className="mt-2 text-[15px] leading-[1.6] text-text-dim">{pillar.body}</p>
              </Reveal>
            );
          })}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <Reveal className="overflow-hidden rounded-[6px] border border-line bg-bg-panel">
            <img src={images.desk} alt="A robot worker at its desk with a green terminal, confetti bursting because it just finished" className="block aspect-[16/10] h-full w-full object-cover" />
          </Reveal>

          <Reveal delay={0.08} className="flex flex-col rounded-[6px] border border-line bg-bg-panel">
            <div className="border-b border-line px-5 py-4">
              <p className="font-heading text-[10px] font-semibold uppercase tracking-[0.16em] text-text-dim">A place worth being in</p>
              <p className="mt-1.5 text-[14px] leading-[1.55] text-text-dim">The details that make you want to keep the office open all day.</p>
            </div>
            <ul className="flex-1 divide-y divide-line-faint">
              {funThings.map((thing) => (
                <li key={thing.name} className="flex items-baseline justify-between gap-4 px-5 py-3">
                  <span className="font-heading text-[12px] uppercase tracking-[0.06em] text-text">{thing.name}</span>
                  <span className="text-right text-[13px] text-text-dim">{thing.note}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        <Reveal className="mt-4">
          <VideoFrame video={playVideo} />
        </Reveal>
      </div>
    </section>
  );
}

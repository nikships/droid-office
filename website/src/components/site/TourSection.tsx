import type React from 'react';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Reveal } from './Reveal';
import { SectionHeader } from './SectionHeader';
import { VideoFrame } from './VideoFrame';
import { tourChapters } from '../../data/tour';

export function TourSection() {
  const [activeId, setActiveId] = useState(tourChapters[0].id);
  const active = tourChapters.find((c) => c.id === activeId) ?? tourChapters[0];

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = tourChapters.findIndex((c) => c.id === activeId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = tourChapters[(idx + 1) % tourChapters.length];
      setActiveId(next.id);
      document.getElementById(`tab-${next.id}`)?.focus();
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = tourChapters[(idx - 1 + tourChapters.length) % tourChapters.length];
      setActiveId(prev.id);
      document.getElementById(`tab-${prev.id}`)?.focus();
    }
  };

  return (
    <section id="tour" className="scroll-mt-14 border-b border-line" aria-labelledby="tour-title">
      <div className="mx-auto max-w-[1240px] px-6 py-24">
        <Reveal>
          <SectionHeader id="tour-title" index="02" label="Tour" title="Walk the floor." lede="Everything you’d do across a dozen terminals, done by walking around a room." />
        </Reveal>

        <div className="mt-14 grid gap-6 lg:grid-cols-[360px_1fr]">
          <div role="tablist" aria-orientation="vertical" aria-label="Tour chapters" onKeyDown={onKeyDown} className="flex flex-col">
            {tourChapters.map((chapter) => {
              const selected = chapter.id === activeId;
              return (
                <button
                  key={chapter.id}
                  id={`tab-${chapter.id}`}
                  role="tab"
                  type="button"
                  aria-selected={selected}
                  aria-controls="tour-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveId(chapter.id)}
                  className={`group relative border-t border-line py-4 pl-5 pr-3 text-left transition-colors duration-[120ms] last:border-b ${selected ? 'bg-bg-panel' : 'hover:bg-bg-panel'}`}
                >
                  <span className={`absolute left-0 top-0 h-full w-px transition-colors duration-[120ms] ${selected ? 'bg-accent' : 'bg-transparent'}`} aria-hidden />

                  <span className="flex items-baseline gap-3">
                    <span className="font-heading text-[11px] tabular-nums text-accent">{chapter.index}</span>
                    <span className={`font-body text-[17px] font-medium tracking-[-0.01em] transition-colors duration-[120ms] ${selected ? 'text-text' : 'text-text-dim group-hover:text-text'}`}>{chapter.title}</span>
                  </span>
                  <AnimatePresence initial={false}>
                    {selected && (
                      <motion.p
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                        className="overflow-hidden pl-[30px] text-[14px] leading-[1.55] text-text-dim"
                      >
                        <span className="block pt-2">{chapter.summary}</span>
                      </motion.p>
                    )}
                  </AnimatePresence>
                </button>
              );
            })}
          </div>

          <div id="tour-panel" role="tabpanel" aria-labelledby={`tab-${active.id}`} className="lg:sticky lg:top-20 lg:self-start">
            <AnimatePresence mode="wait">
              <motion.div key={active.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}>
                <VideoFrame video={active.video} size="lg" />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}

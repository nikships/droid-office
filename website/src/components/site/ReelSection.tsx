import { Eyebrow } from '../Eyebrow';
import { Reveal } from './Reveal';
import { VideoPlaceholder } from './VideoPlaceholder';
import { demoReel } from '../../data/tour';

export function ReelSection() {
  return (
    <section className="border-b border-line" aria-label="Demo reel">
      <div className="mx-auto max-w-[1240px] px-6 py-20">
        <Reveal>
          <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
            <Eyebrow index="00">The reel</Eyebrow>
            <span className="font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">Full walkthrough · 1:30</span>
          </div>
          <VideoPlaceholder video={demoReel} size="lg" />
        </Reveal>
      </div>
    </section>
  );
}

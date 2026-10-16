import { Reveal } from './Reveal';
import { SectionHeader } from './SectionHeader';
import { pocketSteps } from '../../data/install';
import { images } from '../../data/links';

const phones = [
  { src: images.phoneHome, alt: 'The Android app listing the office’s workers by floor', label: 'Workers' },
  { src: images.phoneWorker, alt: 'A worker’s live terminal on the phone, with a composer and quick keys', label: 'Terminal' },
  {
    src: images.phoneNotification,
    alt: 'Phone notifications that a worker is done and another needs you, with a reply box',
    label: 'Notifications',
  },
];

export function PocketSection() {
  return (
    <section id="pocket" className="scroll-mt-14 border-b border-line" aria-labelledby="pocket-title">
      <div className="mx-auto grid max-w-[1240px] gap-14 px-6 py-24 lg:grid-cols-[1fr_1.3fr] lg:items-center">
        <Reveal>
          <SectionHeader id="pocket-title" index="05" label="Android" title="Your office in your pocket." lede="Away from your desk? See every worker on every floor, hire new ones, watch live terminals and prompt them from your phone." />

          <ol className="mt-10 border-t border-line">
            {pocketSteps.map((step, i) => (
              <li key={step.title} className="flex gap-4 border-b border-line py-4">
                <span className="font-heading text-[11px] tabular-nums leading-[1.9] text-accent">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <p className="text-[15px] font-medium text-text">{step.title}</p>
                  <p className="mt-0.5 text-[14px] leading-[1.55] text-text-dim">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-[13px] text-text-dim">A companion to your running office, not a standalone install.</p>
        </Reveal>

        <div className="grid grid-cols-3 gap-3 md:gap-4">
          {phones.map((phone, i) => (
            <Reveal key={phone.label} delay={i * 0.08} className={i === 1 ? 'md:-translate-y-6' : ''}>
              <figure className="overflow-hidden rounded-[8px] border border-line-strong bg-bg-panel">
                <img src={phone.src} alt={phone.alt} className="block aspect-[9/19] w-full object-cover object-top" />
                <figcaption className="border-t border-line px-3 py-2 font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">{phone.label}</figcaption>
              </figure>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

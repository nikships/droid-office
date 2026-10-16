import { Film, Play } from 'lucide-react';
import type { VideoBrief } from '../../types/content';

type VideoPlaceholderProps = {
  video: VideoBrief;
  size?: 'md' | 'lg';
};

export function VideoPlaceholder({ video, size = 'md' }: VideoPlaceholderProps) {
  const large = size === 'lg';
  return (
    <figure className="relative flex w-full flex-col overflow-hidden rounded-[6px] border border-dashed border-line-strong bg-bg-panel" style={{ aspectRatio: '16 / 9' }} aria-label={`Video placeholder: ${video.title}`}>
      <CornerTicks />
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5 font-heading text-[10px] uppercase tracking-[0.12em] text-text-dim">
        <span className="flex items-center gap-2">
          <Film size={12} aria-hidden />
          Video placeholder · {video.slot}
        </span>
        <span className="tabular-nums">{video.duration}</span>
      </div>

      <div className={`flex flex-1 flex-col justify-center ${large ? 'gap-7 p-6 md:p-12' : 'gap-5 p-5 md:p-7'}`}>
        <div className="flex items-center gap-4">
          <span className={`flex shrink-0 items-center justify-center rounded-full border border-line-strong bg-bg-raised text-accent ${large ? 'h-14 w-14' : 'h-11 w-11'}`} aria-hidden>
            <Play size={large ? 20 : 16} fill="currentColor" />
          </span>
          <div className="min-w-0">
            <p className="font-heading text-[10px] uppercase tracking-[0.16em] text-text-dim">Record</p>
            <figcaption className={`font-medium leading-tight tracking-[-0.01em] text-text ${large ? 'text-[20px] md:text-[28px]' : 'text-[16px] md:text-[18px]'}`}>{video.title}</figcaption>
          </div>
        </div>

        <div>
          <p className="mb-2.5 font-heading text-[10px] uppercase tracking-[0.16em] text-text-dim">Should show</p>
          <ol className={`grid gap-x-8 gap-y-2 ${large ? 'md:grid-cols-2' : ''}`}>
            {video.shows.map((item, i) => (
              <li key={item} className="flex gap-3 text-[13px] leading-snug text-text-dim md:text-[14px]">
                <span className="font-heading text-[11px] leading-[1.6] tabular-nums text-accent">{String(i + 1).padStart(2, '0')}</span>
                <span>{item}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </figure>
  );
}

function CornerTicks() {
  const base = 'pointer-events-none absolute h-2.5 w-2.5 border-accent';
  return (
    <>
      <span className={`${base} left-1.5 top-1.5 border-l border-t`} aria-hidden />
      <span className={`${base} right-1.5 top-1.5 border-r border-t`} aria-hidden />
      <span className={`${base} bottom-1.5 left-1.5 border-b border-l`} aria-hidden />
      <span className={`${base} bottom-1.5 right-1.5 border-b border-r`} aria-hidden />
    </>
  );
}

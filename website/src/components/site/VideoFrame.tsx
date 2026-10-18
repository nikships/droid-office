import { Film } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { VideoClip } from '../../types/content';

type VideoFrameProps = {
  video: VideoClip;
  size?: 'md' | 'lg';
  controls?: boolean;
};

export function VideoFrame({ video, size = 'md', controls = false }: VideoFrameProps) {
  const ref = useRef<HTMLVideoElement>(null);

  // Loop clips play only while on screen, so a page of them doesn't decode in the background.
  useEffect(() => {
    const el = ref.current;
    if (!el || controls) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) el.play().catch(() => {});
        else el.pause();
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [controls]);

  return (
    <figure className="relative flex w-full flex-col overflow-hidden rounded-[6px] border border-line bg-bg-panel">
      <CornerTicks />
      <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5 font-heading text-[10px] uppercase tracking-[0.12em] text-text-dim">
        <figcaption className={`flex min-w-0 items-center gap-2 ${size === 'lg' ? 'md:text-[11px]' : ''}`}>
          <Film size={12} className="shrink-0" aria-hidden />
          <span className="truncate">{video.title}</span>
        </figcaption>
        <span className="shrink-0 tabular-nums">{video.duration}</span>
      </div>
      <video
        ref={ref}
        className="block aspect-video w-full bg-bg-void object-cover"
        src={video.src}
        poster={video.poster}
        muted
        loop={!controls}
        playsInline
        controls={controls}
        preload={controls ? 'none' : 'metadata'}
        aria-label={video.title}
      />
    </figure>
  );
}

function CornerTicks() {
  const base = 'pointer-events-none absolute z-10 h-2.5 w-2.5 border-accent';
  return (
    <>
      <span className={`${base} left-1.5 top-1.5 border-l border-t`} aria-hidden />
      <span className={`${base} right-1.5 top-1.5 border-r border-t`} aria-hidden />
      <span className={`${base} bottom-1.5 left-1.5 border-b border-l`} aria-hidden />
      <span className={`${base} bottom-1.5 right-1.5 border-b border-r`} aria-hidden />
    </>
  );
}

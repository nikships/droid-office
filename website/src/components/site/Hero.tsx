import { motion } from 'framer-motion';
import { ArrowRight, Download } from 'lucide-react';
import { Badge, BadgeDot } from '../Badge';
import { Button } from '../Button';
import { OfficeWindow } from './OfficeWindow';
import { RELEASES_URL } from '../../data/links';

export function Hero() {
  return (
    <section id="top" className="border-b border-line" aria-labelledby="hero-title">
      <div className="mx-auto max-w-[1240px] px-6 pb-14 pt-16 md:pb-16 md:pt-24">
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}>
          <div className="mb-8 flex flex-wrap items-center gap-3">
            <Badge tone="accent">
              <BadgeDot spinning />
              Built for Factory Droid
            </Badge>
            <span className="font-heading text-[11px] uppercase tracking-[0.08em] text-text-dim">Mac app · Android companion · MIT</span>
          </div>

          <div className="grid items-end gap-10 lg:grid-cols-[1.4fr_1fr]">
            <h1 id="hero-title" className="font-body text-[46px] font-medium leading-[1.02] tracking-[-0.035em] text-text md:text-[80px]">
              Your AI agents
              <br />
              deserve a desk<span className="text-accent">.</span>
            </h1>
            <div className="lg:pb-3">
              <p className="text-[17px] leading-[1.6] text-text-dim md:text-[18px]">
                Run a whole team of Droid agents from a 3D office. Hire them at desks, hand them work off the wall and step into their live terminals. The most fun way to work with many agents at once.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Button variant="primary" className="!text-[#020202] hover:!bg-white hover:!text-[#020202]" onClick={() => window.open(RELEASES_URL, '_blank', 'noopener')}>
                  <Download size={14} aria-hidden />
                  Download for Mac
                </Button>
                <Button onClick={() => document.getElementById('tour')?.scrollIntoView({ behavior: 'smooth' })}>
                  Take the tour
                  <ArrowRight size={14} aria-hidden />
                </Button>
              </div>
              <p className="mt-4 font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">Apple Silicon · self-updating · no Node required</p>
            </div>
          </div>
        </motion.div>
      </div>

      <motion.div className="mx-auto max-w-[1400px] px-4 pb-20 md:px-6" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.15, ease: [0.4, 0, 0.2, 1] }}>
        <OfficeWindow />
      </motion.div>
    </section>
  );
}

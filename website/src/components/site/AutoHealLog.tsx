import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { RotateCcw } from 'lucide-react';
import { StatusBadge } from '../StatusBadge';
import { autoHealSteps } from '../../data/agents';

const STEP_MS = 1500;
const HOLD_MS = 3200;

export function AutoHealLog() {
  const reduce = useReducedMotion();
  const [count, setCount] = useState(reduce ? autoHealSteps.length : 1);

  useEffect(() => {
    if (reduce) return;
    const done = count >= autoHealSteps.length;
    const t = window.setTimeout(() => setCount(done ? 1 : count + 1), done ? HOLD_MS : STEP_MS);
    return () => window.clearTimeout(t);
  }, [count, reduce]);

  const visible = autoHealSteps.slice(0, count);
  const healed = count >= autoHealSteps.length;

  return (
    <div className="flex h-full flex-col rounded-[6px] border border-line bg-bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="font-heading text-[10px] font-semibold uppercase tracking-[0.16em] text-text-dim">Pipelines board · floor 3</span>
        <span className="flex items-center gap-2 font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">
          Auto-heal
          <span role="img" className="relative inline-flex h-3.5 w-6 items-center rounded-full bg-accent" aria-label="on">
            <span className="absolute right-0.5 h-2.5 w-2.5 rounded-full bg-bg-void" />
          </span>
        </span>
      </div>

      <ol className="flex-1 divide-y divide-line-faint" aria-live="polite">
        <AnimatePresence initial={false}>
          {visible.map((step) => (
            <motion.li
              key={step.time}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
              className="grid grid-cols-[68px_1fr_auto] items-center gap-3 px-4 py-3 md:grid-cols-[72px_120px_1fr_auto]"
            >
              <span className="font-heading text-[11px] tabular-nums text-text-dim">{step.time}</span>
              <span className="hidden font-heading text-[11px] uppercase tracking-[0.06em] text-text md:block">{step.actor}</span>
              <span className="min-w-0 text-[13px] text-text-dim">
                <span className="font-heading text-[11px] uppercase tracking-[0.06em] text-text md:hidden">{step.actor} · </span>
                {step.message}
              </span>
              <StatusBadge status={step.status} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>

      <div className="flex items-center justify-between border-t border-line px-4 py-3 font-heading text-[10px] uppercase tracking-[0.1em] text-text-dim">
        <span>{healed ? 'Healed in 10m 16s · no one paged' : 'Healing…'}</span>
        <RotateCcw size={12} aria-hidden />
      </div>
    </div>
  );
}

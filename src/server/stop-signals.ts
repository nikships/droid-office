/**
 * The signals that close the office. SIGTERM (a restart, the Mac app's Quit) and SIGHUP (the terminal it was
 * started from closed) keep the workers running in their terminal host for the next office; SIGINT (Ctrl+C,
 * Quit and Stop Workers…) ends them. Either way the shutdown runs to the end, so the guest Funnel mapping is
 * removed before the process exits. A second SIGINT or SIGTERM exits at once. A second SIGHUP doesn't: a
 * closing terminal can deliver one from its shell and another from the kernel.
 */
export function onStopSignals(shutdown: (keepWorkers: boolean) => Promise<void>, exit: (code: number) => void = (code) => process.exit(code)) {
  let closing = false;
  const stop = (signal: NodeJS.Signals) => {
    if (closing) {
      if (signal !== 'SIGHUP') exit(1);
      return;
    }
    closing = true;
    const keep = signal !== 'SIGINT';
    // A terminal that is gone fails every later write (EIO, EPIPE) as an 'error' event, which would end
    // the process with an uncaught exception before the shutdown finished. Output no longer matters.
    for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
    console.log(keep ? '\n  closing the office — workers keep running for the next one…' : '\n  closing the office…');
    void shutdown(keep).finally(() => setTimeout(() => exit(0), 300));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, stop);
}

import { useEffect, useState } from 'react';
import { Alert, Linking, Modal, ScrollView, Text, TextInput, View } from 'react-native';
import { companionCapabilities, companionWorkedMs } from '../../shared/companion-roster';
import type { CompanionView } from '../../shared/companion-workspace';
import { sessionWebUrl } from '../../shared/factory-sessions';
import type { WorkerInfo, WorktreeCleanup } from '../../shared/protocol';
import { teamOf } from '../../shared/team';
import { ACTION_OFFLINE, bringInMsg, CLEANUP_LABEL, cleanupAllowed, describeWorktree, forkMsg, prMsg, rebuildMsg, resumeMsg, sendHomeMsg, sendHomeNeedsWorktreeCheck, sendHomeText, type WorkerAction, workerActions } from '../actions';
import { duration, kindLabel, modelLabel, statusLabel } from '../format';
import type { Session, SessionSnapshot } from '../session';
import { Button, Chip, colors, Dot, Label, Note, Row, StatusPill, s, useNow } from './kit';
import { Composer, ThreadView } from './Thread';

type Dialog = 'sendHome' | 'fork' | 'rebuild' | undefined;

/** One worker: its header and actions, then Thread, Raw TTY or (for a guest or cloud worker) its details. */
export function WorkerPane(props: {
  session: Session;
  snap: SessionSnapshot;
  worker: WorkerInfo;
  view: CompanionView;
  focused: boolean;
  /** Phone only: back to the roster, and the quick switcher. */
  onBack?: () => void;
  onStep?: (delta: 1 | -1) => void;
  onSwitch?: () => void;
  /** Tablet only. */
  onClose?: () => void;
  onResize?: (delta: number) => void;
}) {
  const { session, snap, worker } = props;
  const [dialog, setDialog] = useState<Dialog>();
  const [busy, setBusy] = useState(false);
  const shown = session.effectiveView(worker, props.view);
  const ready = session.ready();
  const plain = !!snap.office.floors.find((f) => f.id === snap.office.floor)?.plain;
  const actions = workerActions(worker, ready, plain);
  const now = useNow(5000);
  const worked = companionWorkedMs(worker, now);
  const lead = worker.lead ? session.worker(worker.lead) : undefined;
  const run = async (msg: Parameters<Session['request']>[0], done: string) => {
    setBusy(true);
    let r: Awaited<ReturnType<Session['request']>>;
    try {
      r = await session.request(msg);
    } finally {
      setBusy(false);
    }
    session.toast(r.ok ? done : (r.error ?? 'The office did not confirm this. Check its state before trying again.'), r.ok ? 'info' : 'warn');
    return r.ok;
  };
  const act = (a: WorkerAction) => {
    switch (a.id) {
      case 'thread':
      case 'terminal':
        session.focus(worker.id);
        session.view(worker.id, a.id);
        return;
      case 'resume':
        // A lost worker resumes by rebuilding its worktree first, as in the office.
        if (worker.lost) return setDialog('rebuild');
        return void run(resumeMsg(worker), `${worker.name} is waking up.`);
      case 'pr':
        if (worker.pr) return openLink(worker.pr.url, 'Could not open the pull request.');
        if (worker.repos?.some((r) => r.pr)) return void session.openTool('changes', { workerId: worker.id });
        return void run(prMsg(worker), 'Opening a pull request…');
      case 'bring-in':
        return void run(bringInMsg(worker), `Bringing ${worker.name} in…`);
      case 'changes':
      case 'cloud':
        return void session.openTool(a.id, { workerId: worker.id });
      case 'station-ask':
        return void session.openTool('hire', { kind: 'station', deskId: worker.deskId });
      case 'stop':
        if (!session.stop(worker.id)) session.toast('Disconnected. Nothing was sent.', 'warn');
        return;
      case 'fork':
      case 'rebuild':
        setDialog(a.id);
        return;
      case 'send-home':
        setDialog('sendHome');
        return;
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, borderWidth: props.onClose ? 1 : 0, borderColor: props.focused ? colors.accent : colors.border }} testID={`pane-${worker.id}`}>
      <View style={{ padding: 8, borderBottomWidth: 1, borderColor: colors.border, gap: 4 }}>
        <Row>
          {props.onBack ? <Button small tone="ghost" label="‹ Workers" onPress={props.onBack} testID="pane-back" /> : null}
          <Dot color={worker.color} />
          <Text style={[s.title, { flex: 1 }]} numberOfLines={1}>
            {worker.name}
          </Text>
          {ready ? <StatusPill status={worker.status} label={statusLabel(worker.status)} /> : null}
          {props.onStep ? <Button small tone="ghost" label="‹" accessibilityLabel="Previous worker" onPress={() => props.onStep?.(-1)} testID="pane-prev" /> : null}
          {props.onSwitch ? <Button small tone="ghost" label="Switch" onPress={props.onSwitch} testID="pane-switch" /> : null}
          {props.onStep ? <Button small tone="ghost" label="›" accessibilityLabel="Next worker" onPress={() => props.onStep?.(1)} testID="pane-next" /> : null}
          {props.onResize ? <Button small tone="ghost" label="−" accessibilityLabel="Narrower" onPress={() => props.onResize?.(-0.25)} /> : null}
          {props.onResize ? <Button small tone="ghost" label="+" accessibilityLabel="Wider" onPress={() => props.onResize?.(0.25)} /> : null}
          {props.onClose ? <Button small tone="ghost" label="✕" accessibilityLabel={`Close ${worker.name}`} onPress={props.onClose} testID="pane-close" /> : null}
        </Row>
        <Text style={s.muted} numberOfLines={1}>
          {[kindLabel(worker), modelLabel(worker), worked ? `worked ${duration(worked)}` : undefined, lead ? `lead ${lead.name}` : worker.lead ? 'lead has left' : undefined].filter(Boolean).join(' · ')}
        </Text>
        {worker.task?.name || worker.title ? (
          <Text style={s.text} numberOfLines={1}>
            {worker.task?.name ?? worker.title}
          </Text>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Row>
            {actions.map((a) =>
              a.id === 'thread' || a.id === 'terminal' ? (
                <Chip key={a.id} label={a.label} on={shown === a.id} disabled={!!a.refusal} onPress={() => act(a)} testID={`pane-view-${a.id}`} />
              ) : (
                <Button key={a.id} small label={a.id === 'pr' && worker.pr ? `PR #${worker.pr.number}` : a.label} tone={a.danger ? 'danger' : undefined} disabled={!!a.refusal || busy} onPress={() => act(a)} testID={`action-${a.id}`} />
              ),
            )}
            {worker.cloud && worker.sessionId ? <Button small label="Factory session" onPress={() => openLink(sessionWebUrl(worker.sessionId!), 'Could not open the Factory session.')} /> : null}
          </Row>
        </ScrollView>
        {actions
          .filter((a) => a.refusal && a.id !== 'thread' && a.id !== 'terminal' && a.refusal !== ACTION_OFFLINE)
          .slice(0, 1)
          .map((a) => (
            <Text key={a.id} style={s.muted}>
              {a.label}: {a.refusal}
            </Text>
          ))}
        {worker.lost ? <Note tone="warn">Its worktree was deleted outside the office. Rebuild it, or send it home.</Note> : null}
      </View>
      {shown === 'thread' ? (
        <ThreadView session={session} snap={snap} worker={worker} focused={props.focused} onRaw={() => session.view(worker.id, 'terminal')} onAction={(m) => session.toast(m, 'warn')} />
      ) : shown === 'terminal' ? (
        <session.host.views.Terminal workerId={worker.id} active={props.focused && session.visible && ready} style={{ flex: 1 }} />
      ) : (
        <View style={{ flex: 1 }}>
          <WorkerInfoView worker={worker} />
          {worker.cloud && companionCapabilities(worker).prompt ? <Composer session={session} snap={snap} worker={worker} onRaw={() => undefined} /> : null}
        </View>
      )}
      {dialog === 'sendHome' ? <SendHome session={session} snap={snap} worker={worker} onClose={() => setDialog(undefined)} /> : null}
      {dialog === 'fork' ? <Fork session={session} snap={snap} worker={worker} onClose={() => setDialog(undefined)} /> : null}
      {dialog === 'rebuild' ? (
        <Confirm
          title={`Rebuild ${worker.name}'s worktree?`}
          text={
            worker.lost?.branch === 'gone'
              ? 'Its branch is gone too: the office makes a fresh worktree and starts it again.'
              : `The office puts its worktree back on ${worker.worktree?.branch ?? 'its branch'}${worker.lost?.branch === 'origin' ? ' from origin' : ''} and starts it again.`
          }
          yes="Rebuild"
          onYes={() => void run(rebuildMsg(worker), `Rebuilding ${worker.name}'s worktree…`)}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </View>
  );
}

/** Only https links leave the app; one that can't be opened says so instead of failing silently. */
function openLink(url: string, failed: string): void {
  if (!/^https:\/\//i.test(url)) return void Alert.alert(failed);
  Linking.openURL(url).catch(() => Alert.alert(failed));
}

function WorkerInfoView({ worker }: { worker: WorkerInfo }) {
  const caps = companionCapabilities(worker);
  return (
    <ScrollView style={{ padding: 12 }} testID="pane-info">
      <Text style={s.text}>{worker.activity ?? worker.task?.summary ?? worker.prompt ?? 'Waiting for a task.'}</Text>
      <View style={{ marginTop: 12, gap: 4 }}>
        {worker.guest ? <Note>Running outside the office ({worker.guest.provider}). The office only watches it: use its own terminal.</Note> : null}
        {worker.cloud ? <Note>On Factory · {worker.cloud.computerName}. No local terminal.</Note> : null}
        {!caps.terminal && !worker.guest && !worker.cloud ? <Note>Asleep. Resume it to see its terminal and prompt it.</Note> : null}
        {worker.worktree ? <Text style={s.muted}>Branch {worker.worktree.branch}</Text> : null}
        {worker.repos?.length ? <Text style={s.muted}>Other projects: {worker.repos.map((r) => `${r.name} · ${r.branch}`).join(', ')}</Text> : null}
      </View>
    </ScrollView>
  );
}

export function Confirm(props: { title: string; text: string; yes: string; danger?: boolean; onYes: () => void; onClose: () => void }) {
  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', padding: 24 }}>
        <View style={{ backgroundColor: colors.surface, borderRadius: 8, padding: 16, gap: 10 }}>
          <Text style={s.title}>{props.title}</Text>
          <Text style={s.text}>{props.text}</Text>
          <Row style={{ justifyContent: 'flex-end' }}>
            <Button tone="ghost" label="Cancel" onPress={props.onClose} />
            <Button
              tone={props.danger ? 'danger' : 'primary'}
              label={props.yes}
              onPress={() => {
                props.onClose();
                props.onYes();
              }}
              testID="confirm-yes"
            />
          </Row>
        </View>
      </View>
    </Modal>
  );
}

/** Asks the office what the worktree holds first; deleting is offered only once it answered. A lead's subagents stay. */
function SendHome({ session, snap, worker, onClose }: { session: Session; snap: SessionSnapshot; worker: WorkerInfo; onClose: () => void }) {
  const check = sendHomeNeedsWorktreeCheck(worker);
  const [cleanup, setCleanup] = useState<WorktreeCleanup>('keep');
  const [touched, setTouched] = useState(false);
  const [asked, setAsked] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const state = snap.office.worktrees[worker.id];
  useEffect(() => {
    if (!check) return;
    setAsked(session.inspectWorktree(worker.id));
    const t = setTimeout(() => setTimedOut(true), 8000);
    return () => clearTimeout(t);
  }, [check, session, worker.id]);
  const described = state && worker.worktree ? describeWorktree(state, worker.worktree.branch) : undefined;
  const risky = described ? described.risky : undefined;
  useEffect(() => {
    if (risky !== undefined && !touched) setCleanup(risky ? 'keep' : 'all');
  }, [risky, touched]);
  const subagents = teamOf(Object.values(snap.office.workers), worker.id).length;
  const where = snap.office.floors.find((f) => f.id === snap.office.floor)?.name ?? 'this floor';
  const allowed = cleanupAllowed(cleanup, described);
  const go = async () => {
    onClose();
    const r = await session.request(sendHomeMsg(worker, cleanup));
    session.toast(r.ok ? `${worker.name} went home.` : (r.error ?? 'The office did not confirm this. Check the floor before trying again.'), r.ok ? 'info' : 'warn');
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', padding: 24 }}>
        <View style={{ backgroundColor: colors.surface, borderRadius: 8, padding: 16, gap: 10 }} testID="send-home">
          <Text style={s.title}>Send {worker.name} home?</Text>
          <Text style={s.text}>{sendHomeText(worker, where, subagents)}</Text>
          {check ? (
            <>
              {(['all', 'worktree', 'keep'] as WorktreeCleanup[]).map((c) => (
                <Chip
                  key={c}
                  on={cleanup === c}
                  label={c === 'all' ? 'Delete the worktree and its branch' : c === 'worktree' ? 'Delete the worktree, keep the branch' : 'Keep both'}
                  onPress={() => (setTouched(true), setCleanup(c))}
                  testID={`cleanup-${c}`}
                />
              ))}
              {described ? (
                <Note tone={described.risky ? 'warn' : 'good'}>{described.lines.join('\n')}</Note>
              ) : (
                <Note tone={timedOut || !asked ? 'warn' : 'info'}>
                  {!asked ? 'Disconnected: the worktree could not be checked.' : timedOut ? 'The office did not answer: only Keep both is offered.' : `Checking what ${worker.worktree?.branch} holds…`}
                </Note>
              )}
            </>
          ) : null}
          <Row style={{ justifyContent: 'flex-end' }}>
            <Button tone="ghost" label="Cancel" onPress={onClose} />
            <Button tone="danger" label={CLEANUP_LABEL[cleanup]} disabled={!session.ready() || !allowed} onPress={() => void go()} testID="send-home-yes" />
          </Row>
        </View>
      </View>
    </Modal>
  );
}

function Fork({ session, snap, worker, onClose }: { session: Session; snap: SessionSnapshot; worker: WorkerInfo; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const why = workerActions(worker, session.ready(), !!snap.office.floors.find((f) => f.id === snap.office.floor)?.plain).find((a) => a.id === 'fork')?.refusal;
  const go = async () => {
    setPending(true);
    const r = await session.request(forkMsg(worker, prompt));
    setPending(false);
    if (r.ok) {
      onClose();
      session.toast('Fork created at the nearest free seat');
    } else setError(r.error ?? 'The fork could not be confirmed. Check the floor before trying again.');
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', padding: 24 }}>
        <View style={{ backgroundColor: colors.surface, borderRadius: 8, padding: 16, gap: 10 }} testID="fork">
          <Text style={s.title}>Fork {worker.name}</Text>
          <Text style={s.text}>Same conversation, a separate worktree. The twin gets this worker’s current commit, staged and unstaged edits, and untracked files. The original stays untouched.</Text>
          <Label>New direction (optional)</Label>
          <TextInput style={[s.input, { minHeight: 80 }]} multiline maxLength={20000} value={prompt} onChangeText={setPrompt} placeholder="Try a different approach…" placeholderTextColor={colors.muted} />
          {why || error ? <Text style={[s.muted, { color: colors.warn }]}>{error || why}</Text> : null}
          <Row style={{ justifyContent: 'flex-end' }}>
            <Button tone="ghost" label="Cancel" onPress={onClose} />
            <Button tone="primary" label={pending ? 'Forking…' : 'Fork worker'} disabled={pending || !!why} onPress={() => void go()} testID="fork-yes" />
          </Row>
        </View>
      </View>
    </Modal>
  );
}

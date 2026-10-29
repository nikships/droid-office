import { useMemo, useRef, useState } from 'react';
import { FlatList, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { WorkerInfo } from '../../shared/protocol';
import { slashCommands, slashOf, slashSuggestions, type DroidSlashCommand, type SlashCommand } from '../../shared/slash-commands';
import { isAsleep, isBusy } from '../../shared/status';
import type { ThreadEntry } from '../../shared/worker-thread';
import { presentThread, threadArguments, type ThreadRow } from '../../shared/thread-presentation';
import { statusLabel } from '../format';
import { keyed } from '../markdown';
import type { Session, SessionSnapshot } from '../session';
import { Button, colors, Label, Note, Row, StatusPill, s } from './kit';
import { Markdown } from './Markdown';

const NO_ENTRIES: readonly ThreadEntry[] = [];

/** Thread first: the conversation, its question, Droid's queue and the composer, all from shared logic. */
export function ThreadView(props: { session: Session; snap: SessionSnapshot; worker: WorkerInfo; focused: boolean; onRaw: () => void; onAction: (message: string) => void }) {
  const { session, worker } = props;
  const feed = session.feeds.feed(worker.id);
  const ready = session.ready();
  const busy = isBusy(worker.status);
  // The history replaces its entries array whenever they change, so the array is the memo key.
  const entries = feed?.history.entries ?? NO_ENTRIES;
  const rows = useMemo(() => presentThread(entries, busy), [entries, busy]);
  // Receipts are matched in the session, outside render; render only reads them.
  const { views: queued, droid: droidQueued } = session.queuedFor(worker.id);
  const list = useRef<FlatList<ThreadRow>>(null);
  const [follow, setFollow] = useState(true);
  return (
    <View style={{ flex: 1 }} testID={`thread-${worker.id}`}>
      <FlatList
        ref={list}
        data={rows}
        keyExtractor={(r) => r.id}
        onContentSizeChange={() => follow && list.current?.scrollToEnd({ animated: false })}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          setFollow(contentSize.height - contentOffset.y - layoutMeasurement.height < 80);
        }}
        scrollEventThrottle={200}
        ListHeaderComponent={
          <View style={{ padding: 8, gap: 6 }}>
            {feed?.history.hasMore ? <Button small label="Load earlier messages" disabled={!ready || !!feed.pending} onPress={() => session.readEarlier(worker.id)} testID="thread-earlier" /> : null}
            {props.focused ? <TeamActivity session={session} snap={props.snap} /> : null}
          </View>
        }
        renderItem={({ item }) => <RowView row={item} worker={worker} asking={worker.status === 'needs_input'} />}
        ListEmptyComponent={
          <View style={{ padding: 16 }}>
            <Text style={s.muted}>
              {feed?.error ? 'Conversation unavailable. Retry below, or open Raw TTY.' : !feed?.received ? 'Reading the conversation…' : 'Start a conversation. Your messages and the worker’s replies will appear here.'}
            </Text>
          </View>
        }
        ListFooterComponent={
          <View style={{ padding: 8, gap: 6 }}>
            {queued.length ? (
              <View testID="thread-queued" style={{ borderWidth: 1, borderColor: colors.border, padding: 8, borderRadius: 4, gap: 4 }}>
                <Label>Queued · {queued.length}</Label>
                {queued.map((q) => (
                  <Text key={q.key} style={s.text} numberOfLines={3}>
                    {q.text || 'Image attached'}
                    {q.more ? ` (${q.more} more line${q.more === 1 ? '' : 's'})` : q.preview ? ' (shortened)' : ''}
                  </Text>
                ))}
                <Row>
                  <Text style={[s.muted, { flex: 1 }]}>{queued.length === 1 ? 'Sent once this turn is over.' : 'Sent in order once this turn is over.'}</Text>
                  {droidQueued ? <Button small tone="ghost" label="Clear queue" disabled={!ready} onPress={() => session.clearQueue(worker.id) || props.onAction('Disconnected. Nothing was sent.')} /> : null}
                </Row>
              </View>
            ) : null}
          </View>
        }
      />
      {feed?.history.historical || !follow ? (
        <View style={{ position: 'absolute', right: 12, bottom: 140 }}>
          <Button
            small
            label={feed?.history.historical ? 'Back to the latest' : 'Jump to latest'}
            onPress={() => {
              if (feed?.history.historical) session.readLatest(worker.id);
              setFollow(true);
              list.current?.scrollToEnd({ animated: true });
            }}
            testID="thread-latest"
          />
        </View>
      ) : null}
      <Row style={{ paddingHorizontal: 8 }} wrap>
        {feed?.error ? <Text style={[s.muted, { color: colors.danger, flex: 1 }]}>{feed.error}</Text> : null}
        {feed?.error ? <Button small label="Retry" disabled={!ready} onPress={() => session.retryThread(worker.id)} testID="thread-retry" /> : null}
        {feed?.error ? <Button small label="Open Raw TTY" onPress={props.onRaw} /> : null}
        {isAsleep(worker.status) ? <Text style={[s.muted, { flex: 1 }]}>Resume this worker to send another message.</Text> : null}
      </Row>
      <Question session={session} worker={worker} focused={props.focused} onRaw={props.onRaw} />
      <Composer session={session} snap={props.snap} worker={worker} onRaw={props.onRaw} />
    </View>
  );
}

function RowView({ row, worker, asking }: { row: ThreadRow; worker: WorkerInfo; asking: boolean }) {
  if (row.kind === 'message') {
    const user = row.entry.role === 'user';
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 6, alignItems: user ? 'flex-end' : 'stretch' }}>
        {row.startsTurn ? <Label>{worker.name}</Label> : null}
        {user ? (
          <Text selectable style={[s.text, { backgroundColor: colors.raised, padding: 8, borderRadius: 6, maxWidth: '90%' }]}>
            {row.entry.text ?? ''}
          </Text>
        ) : (
          <Markdown text={row.entry.text ?? ''} />
        )}
      </View>
    );
  }
  if (row.kind === 'thought') return <Thought row={row} />;
  if (row.kind === 'notice') {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
        <Text style={[s.muted, row.tone === 'danger' && { color: colors.danger }]}>{row.text}</Text>
      </View>
    );
  }
  return <Activity row={row} asking={asking} />;
}

function Thought({ row }: { row: Extract<ThreadRow, { kind: 'thought' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} testID={`thought-${row.id}`}>
        <Text style={s.muted} numberOfLines={open ? undefined : 1}>
          {open ? '▾' : '▸'} Thought · {row.preview}
        </Text>
      </Pressable>
      {open ? (
        <Text selectable style={[s.muted, { paddingLeft: 12 }]}>
          {row.entry.text}
        </Text>
      ) : null}
    </View>
  );
}

function Activity({ row, asking }: { row: Extract<ThreadRow, { kind: 'activity' }>; asking: boolean }) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const status = [row.failed.length ? `${row.failed.length} failed` : '', row.cancelled ? `${row.cancelled} cancelled` : '', row.noResult ? `${row.noResult} no result` : ''].filter(Boolean).join(' · ');
  const toggle = (id: string) => setOpened((o) => ({ ...o, [id]: !o[id] }));
  const label = !row.actions.length && !row.plan ? 'Thought' : `${row.live && !asking ? 'Working · ' : ''}${row.label}`;
  const current = row.actions.filter((a) => a.state === 'working').at(-1);
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} testID={`activity-${row.id}`}>
        <Row>
          <Text style={[s.muted, row.state === 'failed' && { color: colors.danger }, row.state === 'working' && { color: colors.accent }]}>{open ? '▾' : '▸'}</Text>
          <Text style={[s.muted, { flex: 1 }]} numberOfLines={open ? undefined : 1}>
            {label}
          </Text>
          {status ? <Text style={[s.muted, { color: colors.warn }]}>{status}</Text> : null}
        </Row>
      </Pressable>
      {row.live && !row.failed.length && current && current.title !== row.label ? <Text style={[s.muted, { paddingLeft: 16 }]}>{current.title}</Text> : null}
      {row.failed.map((a) => (
        <Text key={a.entry.id} style={[s.muted, { color: colors.danger, paddingLeft: 16 }]} numberOfLines={3}>
          {a.title}:{' '}
          {a.entry.output
            ?.split('\n')
            .find((l) => l.trim())
            ?.slice(0, 240) ?? 'No error details were recorded.'}
        </Text>
      ))}
      {open ? (
        <View style={{ paddingLeft: 16, gap: 4, marginTop: 4 }}>
          {row.items.map((item) => {
            const id = item.entry.id;
            const args = threadArguments(item.entry);
            const state = item.state === 'cancelled' ? 'Cancelled' : item.state === 'failed' ? 'Failed' : item.state === 'working' ? 'Running' : item.state === 'incomplete' ? 'No result' : '';
            return (
              <View key={id}>
                <Pressable onPress={() => toggle(id)} accessibilityRole="button" accessibilityState={{ expanded: !!opened[id] }} testID={`tool-${id}`}>
                  <Row>
                    <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>
                      {opened[id] ? '▾' : '▸'} {item.title}
                      {item.detail ? <Text style={s.muted}> {item.detail}</Text> : null}
                    </Text>
                    {state ? <Text style={[s.muted, item.state === 'failed' && { color: colors.danger }]}>{state}</Text> : null}
                  </Row>
                </Pressable>
                {opened[id] ? (
                  <View style={{ gap: 4, marginTop: 4 }}>
                    {args ? <Label>{args.label}</Label> : null}
                    {args ? (
                      <ScrollView horizontal>
                        <Text selectable style={s.code}>
                          {args.text}
                        </Text>
                      </ScrollView>
                    ) : null}
                    <Label>{item.state === 'cancelled' ? 'Cancelled' : item.entry.error ? 'Error' : 'Result'}</Label>
                    <ScrollView horizontal>
                      <Text selectable style={s.code}>
                        {item.entry.output ?? 'No result recorded in this session.'}
                      </Text>
                    </ScrollView>
                  </View>
                ) : null}
              </View>
            );
          })}
          {row.plan ? (
            <View>
              <Label>Plan</Label>
              {keyed(row.plan, (step) => step.text).map(([key, step]) => (
                <Text key={key} style={s.muted}>
                  {step.done ? 'Done' : step.active ? 'Now' : 'Next'} · {step.text}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function TeamActivity({ session, snap }: { session: Session; snap: SessionSnapshot }) {
  const team = session.feeds.team;
  if (!session.feeds.teamLead || !team.total) return null;
  if (!session.feeds.teamOn) return <Text style={s.muted}>Team activity is off while this many panes are open. Open a subagent from the roster.</Text>;
  const open = session.teamOpen;
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 4, padding: 8 }} testID="team-activity">
      <Pressable onPress={() => session.setTeamOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <Text style={s.text}>
          {open ? '▾' : '▸'} Team activity · {team.total}
        </Text>
      </Pressable>
      {open
        ? [...team.members.values()].map((m) => {
            const rows = presentThread(m.history.entries, isBusy(m.worker.status)).slice(-4);
            const last = rows.at(-1);
            const activity = m.worker.activity || (last?.kind === 'activity' ? last.label : last?.kind === 'message' ? last.entry.text : last?.kind === 'thought' ? last.preview : last?.text) || m.worker.title || 'No recent activity';
            return (
              <View key={m.worker.id} style={{ marginTop: 6 }}>
                <Row>
                  <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>
                    {m.worker.name}
                  </Text>
                  <StatusPill status={m.worker.status} label={statusLabel(m.worker.status)} />
                  <Button small tone="ghost" label="Open thread" disabled={!session.ready()} onPress={() => session.open(m.worker.id)} />
                </Row>
                <Text style={s.muted} numberOfLines={2}>
                  {m.error ? `Conversation unavailable: ${m.error}` : activity.split('\n')[0].slice(0, 200)}
                </Text>
              </View>
            );
          })
        : null}
      {open && team.total > team.members.size ? (
        <Text style={s.muted}>
          Showing {team.members.size} of {team.total} workers. Open other threads from the roster.
        </Text>
      ) : null}
      {snap.link.phase !== 'connected' ? <Text style={s.muted}>Offline.</Text> : null}
    </View>
  );
}

/** Compact entry only. Choosing and submitting happen in the full-size workspace. */
function Question({ session, worker, focused, onRaw }: { session: Session; worker: WorkerInfo; focused: boolean; onRaw: () => void }) {
  if (worker.status !== 'needs_input') return null;
  const menu = session.questionMenu(worker.id);
  return (
    <View testID="thread-question" style={{ borderTopWidth: 1, borderColor: colors.warn, padding: 8, gap: 6 }}>
      {menu ? (
        <Row wrap>
          <Text style={[s.muted, { flex: 1 }]}>{worker.name} needs your answer.</Text>
          <Button label="Answer questions" tone="primary" disabled={!focused || !session.ready()} onPress={() => session.openQuestion(worker.id)} testID="question-open" />
        </Row>
      ) : (
        <>
          <Note tone="warn">This CLI dialog cannot be answered safely here. Open Raw TTY to continue.</Note>
          <Button small label="Open Raw TTY" disabled={!focused} onPress={onRaw} testID="question-fallback" />
        </>
      )}
    </View>
  );
}

/** The draft box for one worker; a cloud worker, which has no Thread here, gets it under its details. */
export function Composer({ session, snap, worker, onRaw }: { session: Session; snap: SessionSnapshot; worker: WorkerInfo; onRaw: () => void }) {
  const ws = session.floorWorkspace();
  const draft = Object.hasOwn(ws.drafts, worker.id) ? ws.drafts[worker.id] : { text: '', attachments: [] };
  const [told, setTold] = useState('');
  const [live, setLive] = useState<DroidSlashCommand[]>([]);
  const [asked, setAsked] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const busy = isBusy(worker.status);
  const sending = session.isSending(worker.id);
  const picking = session.isPicking(worker.id);
  const asleep = isAsleep(worker.status) || !!worker.lost;
  const disabled = !session.ready() || asleep || worker.status === 'needs_input' || !!worker.guest || sending;
  const commands = useMemo(() => slashCommands(live), [live]);
  const suggestions = worker.kind === 'agent' && !slashClosed && !disabled ? slashSuggestions(draft.text, commands) : [];
  const loadSlash = () => {
    if (worker.kind !== 'agent' || Date.now() - asked < 60_000 || !session.ready()) return;
    setAsked(Date.now());
    session.host
      .http({ method: 'GET', path: '/api/agents/droid/commands', query: { worker: worker.id } })
      .then((r) => {
        const list = (r.body as { commands?: unknown } | undefined)?.commands;
        if (r.status === 200 && Array.isArray(list)) setLive(list as DroidSlashCommand[]);
        else setAsked(0);
      })
      .catch(() => setAsked(0));
  };
  const change = (text: string) => {
    setTold('');
    setSlashClosed(false);
    if (text.trimStart().startsWith('/')) loadSlash();
    session.draft(worker.id, text);
  };
  const pick = (c: SlashCommand) => change(`/${c.name} `);
  const send = async (queue: boolean) => {
    let error: string | undefined;
    try {
      error = await session.submit(worker.id, queue);
    } catch {
      error = 'The office did not confirm this message. Check the thread before sending it again.';
    }
    setTold(error ?? '');
  };
  return (
    <View style={{ padding: 8, borderTopWidth: 1, borderColor: colors.border, gap: 6 }} testID="composer">
      {suggestions.length ? (
        <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 4 }} testID="slash-menu">
          {suggestions.map((c) => (
            <Pressable key={c.name} onPress={() => pick(c)} style={{ padding: 6 }} accessibilityRole="button" testID={`slash-${c.name}`}>
              <Text style={s.text}>
                /{c.name} <Text style={s.muted}>{c.description}</Text>
                {c.kind === 'tty' ? <Text style={s.muted}> · Raw TTY</Text> : c.source ? <Text style={s.muted}> · {c.source === 'skill' ? 'Skill' : 'Command'}</Text> : null}
              </Text>
            </Pressable>
          ))}
          <Button small tone="ghost" label="Close" onPress={() => setSlashClosed(true)} />
        </View>
      ) : null}
      {draft.attachments.length ? (
        <ScrollView horizontal testID="composer-images">
          {draft.attachments.map((id, i) => (
            <View key={id} style={{ marginRight: 6, alignItems: 'center' }}>
              {snap.previews[id] ? <Image source={{ uri: snap.previews[id] }} style={{ width: 48, height: 48, borderRadius: 4 }} /> : <View style={{ width: 48, height: 48, backgroundColor: colors.raised }} />}
              <Button small tone="ghost" label={`✕ ${i + 1}`} accessibilityLabel={`Remove image ${i + 1}`} onPress={() => session.removeAttachment(worker.id, id)} />
            </View>
          ))}
        </ScrollView>
      ) : null}
      <TextInput
        testID="composer-input"
        style={[s.input, { maxHeight: 140 }]}
        multiline
        maxLength={20000}
        editable={!disabled}
        value={draft.text}
        onChangeText={change}
        placeholder={busy ? `Steer ${worker.name}, or queue for after this turn…` : worker.kind === 'shell' ? `Command for ${worker.name}…` : `Reply to ${worker.name}…`}
        placeholderTextColor={colors.muted}
        accessibilityLabel="Message to worker"
      />
      <Row wrap>
        {worker.kind === 'agent' ? <Button small tone="ghost" label={picking ? 'Attaching…' : 'Pictures'} disabled={disabled || picking} onPress={() => void session.attach(worker.id)} testID="composer-attach" /> : null}
        {worker.kind === 'agent' && (busy || worker.status === 'needs_input') ? (
          <Button small label="Stop" tone="danger" disabled={!session.ready()} onPress={() => (session.stop(worker.id) ? setTold('') : setTold('Disconnected. Nothing was sent.'))} testID="composer-stop" />
        ) : null}
        <View style={{ flex: 1 }} />
        {busy && worker.kind === 'agent' ? <Button small label="Queue" disabled={disabled || !!slashOf(draft.text) || picking} onPress={() => void send(true)} testID="composer-queue" /> : null}
        <Button small tone="primary" label={sending ? 'Sending…' : busy ? 'Send now' : 'Send'} disabled={disabled || picking || (!draft.text.trim() && !draft.attachments.length)} onPress={() => void send(false)} testID="composer-send" />
      </Row>
      {told ? <Text style={[s.muted, { color: colors.warn }]}>{told}</Text> : null}
      {slashOf(draft.text)?.command?.kind === 'tty' ? <Text style={s.muted}>This command opens one of Droid’s dialogs: Raw TTY opens after it is sent.</Text> : null}
      {worker.status === 'needs_input' ? <Button small tone="ghost" label="Open Raw TTY" onPress={onRaw} /> : null}
    </View>
  );
}

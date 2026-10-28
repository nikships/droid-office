import { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { companionRoster, companionWorkedMs, type RosterFilter, type RosterRow } from '../../shared/companion-roster';
import type { WorkerStatus } from '../../shared/protocol';
import { ago, childSummary, duration, kindLabel, modelLabel, oneLine, statusLabel } from '../format';
import type { Session, SessionSnapshot } from '../session';
import { Button, Chip, colors, Dot, Label, Row, StatusPill, s, useNow } from './kit';

const STATUSES: WorkerStatus[] = ['needs_input', 'working', 'done', 'idle', 'starting', 'exited', 'offline'];
const KINDS: NonNullable<RosterFilter['kind']>[] = ['agent', 'shell', 'cloud', 'guest'];
const KIND_LABEL: Record<NonNullable<RosterFilter['kind']>, string> = { agent: 'Droid', shell: 'Shell', cloud: 'Cloud', guest: 'Guest' };

/** The roster's order as shown, for previous and next in the phone's conversation. */
export function rosterOrder(snap: SessionSnapshot): string[] {
  const floor = snap.office.floor;
  const collapsed = new Set(floor && Object.hasOwn(snap.workspace.floors, floor) ? snap.workspace.floors[floor].collapsed : []);
  return companionRoster(Object.values(snap.office.workers), {}, collapsed).map((r) => r.worker.id);
}

export function Roster(props: { session: Session; snap: SessionSnapshot; wide: boolean; onOpen: (id: string, pin: boolean) => void; onHire: () => void }) {
  const { session, snap, wide } = props;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<WorkerStatus | undefined>();
  const [kind, setKind] = useState<RosterFilter['kind']>();
  const [filters, setFilters] = useState(false);
  const now = useNow();
  const ws = session.floorWorkspace();
  const workers = snap.office.workers;
  const rows = useMemo(() => companionRoster(Object.values(workers), { query, status, kind }, new Set(ws.collapsed)), [workers, query, status, kind, ws.collapsed]);
  const ready = session.ready();
  const total = Object.keys(workers).length;
  const pinned = new Set(ws.panes.map((p) => p.workerId));
  return (
    <View style={{ flex: 1 }} testID="roster">
      <Row style={{ padding: 8 }}>
        <TextInput testID="roster-search" style={[s.input, { flex: 1 }]} value={query} onChangeText={setQuery} placeholder="Search workers, tasks, models" placeholderTextColor={colors.muted} autoCorrect={false} />
        <Button small label={filters ? 'Hide filters' : 'Filters'} onPress={() => setFilters(!filters)} tone="ghost" testID="roster-filters" />
        <Button small label="Hire" onPress={props.onHire} disabled={!ready} tone="primary" testID="roster-hire" />
      </Row>
      {filters ? (
        <View style={{ paddingHorizontal: 8, gap: 6 }}>
          <Row wrap>
            <Chip label="Any status" on={!status} onPress={() => setStatus(undefined)} />
            {STATUSES.map((st) => (
              <Chip key={st} label={statusLabel(st)} on={status === st} onPress={() => setStatus(status === st ? undefined : st)} testID={`roster-status-${st}`} />
            ))}
          </Row>
          <Row wrap>
            <Chip label="Any kind" on={!kind} onPress={() => setKind(undefined)} />
            {KINDS.map((k) => (
              <Chip key={k} label={KIND_LABEL[k]} on={kind === k} onPress={() => setKind(kind === k ? undefined : k)} testID={`roster-kind-${k}`} />
            ))}
          </Row>
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.worker.id}
        renderItem={({ item }) => (
          <RosterItem
            row={item}
            now={now}
            lead={item.worker.lead ? workers[item.worker.lead]?.name : undefined}
            active={ws.active === item.worker.id}
            pinned={pinned.has(item.worker.id)}
            wide={wide}
            onOpen={props.onOpen}
            onCollapse={() => session.collapse(item.worker.id)}
          />
        )}
        ListEmptyComponent={
          <View style={{ padding: 16 }}>
            <Text style={s.muted}>{!snap.office.synced ? 'Waiting for the office…' : total ? 'No worker matches.' : 'Nobody works on this floor yet. Hire one to start.'}</Text>
          </View>
        }
      />
    </View>
  );
}

function RosterItem(props: { row: RosterRow; now: number; lead?: string; active: boolean; pinned: boolean; wide: boolean; onOpen: (id: string, pin: boolean) => void; onCollapse: () => void }) {
  const { row, now } = props;
  const w = row.worker;
  const model = modelLabel(w);
  const worked = companionWorkedMs(w, now);
  const task = w.task?.name ?? w.title;
  const activity = oneLine(w.activity ?? w.task?.summary ?? w.prompt);
  const waited = (w.status === 'needs_input' || w.status === 'done') && !w.acked ? ago(w.waitingSince, now) : undefined;
  const input = ago(w.lastInputAt, now);
  const counts = row.descendantCount ? `${row.descendantCount} subagent${row.descendantCount === 1 ? '' : 's'}${childSummary(row.childStatuses) ? ` · ${childSummary(row.childStatuses)}` : ''}` : '';
  return (
    <Pressable
      testID={`roster-row-${w.id}`}
      accessibilityLabel={`${w.name}, ${statusLabel(w.status)}`}
      onPress={() => props.onOpen(w.id, false)}
      style={[{ paddingVertical: 8, paddingRight: 8, paddingLeft: 8 + row.depth * 18, borderBottomWidth: 1, borderColor: colors.border, opacity: row.matches ? 1 : 0.55 }, props.active && { backgroundColor: colors.raised }]}
    >
      <Row>
        {row.childCount ? (
          <Pressable testID={`roster-collapse-${w.id}`} accessibilityLabel={row.collapsed ? `Show ${w.name}'s subagents` : `Hide ${w.name}'s subagents`} onPress={props.onCollapse} hitSlop={8}>
            <Text style={[s.text, { width: 16 }]}>{row.collapsed ? '▸' : '▾'}</Text>
          </Pressable>
        ) : (
          <View style={{ width: 16 }} />
        )}
        <Dot color={w.color} />
        <Text style={[s.text, { flex: 1, fontWeight: '500' }]} numberOfLines={1}>
          {w.name}
        </Text>
        <StatusPill status={w.status} label={statusLabel(w.status)} />
        {props.wide ? <Button small tone="ghost" label={props.pinned ? 'Pinned' : 'Pin'} disabled={props.pinned} onPress={() => props.onOpen(w.id, true)} testID={`roster-pin-${w.id}`} /> : null}
      </Row>
      <View style={{ paddingLeft: 34, gap: 2, marginTop: 2 }}>
        <Text style={s.muted} numberOfLines={1}>
          {[kindLabel(w), model, worked ? `worked ${duration(worked)}` : undefined, w.lost ? 'worktree missing' : undefined].filter(Boolean).join(' · ')}
        </Text>
        {task ? (
          <Text style={s.text} numberOfLines={1}>
            {task}
          </Text>
        ) : null}
        {activity ? (
          <Text style={s.muted} numberOfLines={2}>
            {activity}
          </Text>
        ) : null}
        {w.lead && !props.lead ? <Text style={s.muted}>Lead has left this floor</Text> : row.depth === 0 && props.lead ? <Text style={s.muted}>Lead: {props.lead}</Text> : null}
        {counts ? <Label>{counts}</Label> : null}
        {waited || input ? <Text style={s.muted}>{[waited && `waiting ${waited}`, input && `last input ${input}`].filter(Boolean).join(' · ')}</Text> : null}
      </View>
    </Pressable>
  );
}

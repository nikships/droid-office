import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, BackHandler, Modal, Pressable, SafeAreaView, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { NOT_OFFERED, TOOLS } from '../../shared/companion-tools';
import { MAX_COMPANION_PANES } from '../../shared/companion-workspace';
import { currentFloor } from '../office-state';
import type { MobileHost } from '../host';
import { Session } from '../session';
import { HireSheet } from './Hire';
import { Button, Chip, colors, Label, Note, Row, s } from './kit';
import { Roster, rosterOrder } from './Roster';
import { WorkerPane } from './WorkerPane';

/** Wide enough for the roster beside pinned panes: a tablet, an open foldable, a phone in landscape. */
export const WIDE_DP = 840;

type Tab = 'workers' | 'tools' | 'device';

export function App({ host }: { host: MobileHost }) {
  const [session] = useState(() => new Session(host));
  const snap = useSyncExternalStore(session.subscribe, session.snapshot);
  useEffect(() => {
    void session.start().catch(() => undefined);
    return () => session.dispose();
  }, [session]);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_DP;
  const [tab, setTab] = useState<Tab>('workers');
  const [hiring, setHiring] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  useEffect(() => session.setPhone(!wide), [session, wide]);
  // Tools and Device cover the workspace: its panes stop reading and holding while they do.
  useEffect(() => session.setWorkspaceShown(tab === 'workers'), [session, tab]);
  // Whatever opened a worker (the roster, a notification, a hire, a tool) shows it: the Workers tab.
  const [seen, setSeen] = useState(snap.navigation);
  if (seen !== snap.navigation) {
    setSeen(snap.navigation);
    setTab('workers');
    setSwitcher(false);
    // The Hire sheet is full screen: left open it would cover the worker this went to. Closing it
    // discards its pictures.
    setHiring(false);
  }
  const [toolSeen, setToolSeen] = useState(snap.toolNavigation);
  if (toolSeen !== snap.toolNavigation) {
    setToolSeen(snap.toolNavigation);
    setTab('tools');
    setSwitcher(false);
    setHiring(false);
  }
  const tool = snap.tool;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => session.setVisible(state === 'active'));
    return () => sub.remove();
  }, [session]);
  const ws = session.floorWorkspace();
  // On a phone the active worker is the conversation; none active is the roster. A worker that went
  // (sent home, another floor) leaves none active.
  const active = ws.active ? session.worker(ws.active) : undefined;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (hiring || switcher) return setHiring(false), setSwitcher(false), true;
      if (tab === 'tools' && tool) return session.closeTool(), true;
      if (tab !== 'workers') return setTab('workers'), true;
      if (!wide && active) return session.focus(''), true;
      return false;
    });
    return () => sub.remove();
  }, [session, hiring, switcher, tab, tool, wide, active]);
  const open = useCallback((id: string, pin: boolean) => void session.open(id, pin), [session]);
  const order = rosterOrder(snap);
  const floor = currentFloor(snap.office);
  const link = snap.link;
  const banner =
    link.phase === 'unauthorized'
      ? (link.reason ?? 'This phone is no longer paired with the office. Pair it again.')
      : link.phase !== 'connected'
        ? link.phase === 'connecting'
          ? 'Connecting to the office…'
          : (link.reason ?? 'Offline. Unsent messages and pictures were cleared; panes come back when the office does.')
        : !session.ready()
          ? snap.switching
            ? snap.floorSlow
              ? 'The office hasn’t answered the floor change. Nothing can be sent until it does. Ask again, or check the office on your Mac.'
              : 'Changing floors…'
            : 'Waiting for the office…'
          : undefined;
  const officeName = snap.offices.offices.find((o) => o.id === snap.offices.active)?.name;
  if (snap.bootError) {
    return (
      <SafeAreaView style={[s.sheet, { justifyContent: 'center', gap: 12 }]}>
        <Text style={s.title}>Droid Office couldn’t start</Text>
        <Note tone="bad">{snap.bootError}</Note>
        <Button tone="primary" label="Try again" onPress={() => void session.retryStart().catch(() => undefined)} testID="boot-retry" />
      </SafeAreaView>
    );
  }
  if (snap.started && !snap.offices.offices.length) {
    return (
      <SafeAreaView style={[s.sheet, { justifyContent: 'center', gap: 12 }]}>
        <Text style={s.title}>Pair this phone with your office</Text>
        <Text style={s.text}>Open Droid Office on your Mac, then scan its pairing code.</Text>
        <Button tone="primary" label="Pair an office" onPress={() => host.openPairing()} testID="pair" />
      </SafeAreaView>
    );
  }
  const phoneConversation = !wide && active && tab === 'workers';
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} testID="app">
      {!phoneConversation ? (
        <View style={{ borderBottomWidth: 1, borderColor: colors.border }}>
          <Row style={{ paddingHorizontal: 8, paddingTop: 8 }}>
            <Pressable onPress={() => setTab('device')} style={{ flex: 1 }} accessibilityRole="button" testID="office-name">
              <Text style={s.title} numberOfLines={1}>
                {officeName ?? 'Droid Office'}
                {floor ? <Text style={s.muted}> · {floor.name}</Text> : null}
              </Text>
            </Pressable>
            <Chip label="Workers" on={tab === 'workers'} onPress={() => setTab('workers')} testID="tab-workers" />
            <Chip label="Tools" on={tab === 'tools'} onPress={() => setTab('tools')} testID="tab-tools" />
            <Chip label="Device" on={tab === 'device'} onPress={() => setTab('device')} testID="tab-device" />
          </Row>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ paddingHorizontal: 8, paddingVertical: 6 }} testID="floors">
            {snap.office.floors.map((f) => (
              <Chip
                key={f.id}
                label={`${f.name}${f.waiting ? ` · ${f.waiting} waiting` : f.busy ? ` · ${f.busy} busy` : ''}`}
                on={f.id === (snap.switching ?? snap.office.floor)}
                disabled={!session.ready() && f.id !== snap.office.floor}
                onPress={() => session.goFloor(f.id)}
                testID={`floor-${f.id}`}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}
      {banner ? (
        <View style={{ paddingHorizontal: 8 }}>
          <Note tone={link.phase === 'unauthorized' ? 'bad' : 'warn'}>{banner}</Note>
          {link.phase === 'unauthorized' ? <Button small label="Pair again" onPress={() => host.openPairing()} /> : null}
          {snap.switching && snap.floorSlow && link.phase === 'connected' ? <Button small label="Ask again" onPress={() => session.askFloorAgain() || session.toast('Disconnected. Nothing was sent.', 'warn')} testID="floor-retry" /> : null}
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        {tab === 'device' ? (
          <Device host={host} session={session} snap={snap} />
        ) : tab === 'tools' ? (
          <Tools session={session} snap={snap} onHire={() => setHiring(true)} />
        ) : wide ? (
          <View style={{ flex: 1, flexDirection: 'row' }}>
            <View style={{ width: 340, borderRightWidth: 1, borderColor: colors.border }}>
              <Roster session={session} snap={snap} wide onOpen={open} onHire={() => setHiring(true)} />
            </View>
            <View style={{ flex: 1, flexDirection: 'row' }} testID="panes">
              {ws.panes.length ? (
                ws.panes.map((p) => {
                  const w = session.worker(p.workerId);
                  if (!w) return null;
                  return (
                    <View key={p.workerId} style={{ flex: p.size }} onTouchStart={() => ws.active !== p.workerId && session.focus(p.workerId)}>
                      <WorkerPane session={session} snap={snap} worker={w} view={p.view} focused={ws.active === p.workerId} onClose={() => session.close(p.workerId)} onResize={(d) => session.resize(p.workerId, p.size + d)} />
                    </View>
                  );
                })
              ) : (
                <View style={{ padding: 24 }}>
                  <Text style={s.muted}>Open a worker from the list. Pin up to {MAX_COMPANION_PANES} to see them side by side.</Text>
                </View>
              )}
            </View>
          </View>
        ) : phoneConversation && active ? (
          <WorkerPane
            key={active.id}
            session={session}
            snap={snap}
            worker={active}
            view={ws.panes.find((p) => p.workerId === active.id)?.view ?? 'thread'}
            focused
            onBack={() => session.focus('')}
            onStep={(d) => session.step(order, d)}
            onSwitch={() => setSwitcher(true)}
          />
        ) : (
          <Roster session={session} snap={snap} wide={false} onOpen={open} onHire={() => setHiring(true)} />
        )}
      </View>
      <Toasts session={session} snap={snap} />
      {hiring ? <HireSheet session={session} snap={snap} onClose={() => setHiring(false)} /> : null}
      {switcher ? (
        <Modal animationType="slide" onRequestClose={() => setSwitcher(false)}>
          <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
            <Row style={{ padding: 8 }}>
              <Text style={[s.title, { flex: 1 }]}>Switch worker</Text>
              <Button small tone="ghost" label="Close" onPress={() => setSwitcher(false)} />
            </Row>
            <Roster
              session={session}
              snap={snap}
              wide={false}
              onOpen={(id) => {
                setSwitcher(false);
                open(id, false);
              }}
              onHire={() => (setSwitcher(false), setHiring(true))}
            />
          </SafeAreaView>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

/** One management tool at a time in the native sealed host; the agent workspace stays as it was. */
function Tools({ session, snap, onHire }: { session: Session; snap: ReturnType<Session['snapshot']>; onHire: () => void }) {
  const Management = session.host.views.Management;
  const floorId = snap.office.floor;
  const tool = snap.tool;
  return (
    <View style={{ flex: 1 }} testID="tools">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, padding: 8 }}>
        {TOOLS.filter((t) => t.listed).map((t) => {
          const why = session.toolRefusal(t.id);
          return (
            <Chip
              key={t.id}
              label={`${t.icon} ${t.label}`}
              on={tool?.id === t.id}
              onPress={() => {
                if (why) session.toast(why, 'warn');
                else if (t.id === 'hire') onHire();
                else if (tool?.id === t.id) session.closeTool();
                else session.openTool(t.id);
              }}
              hint={why}
              testID={`tool-${t.id}`}
            />
          );
        })}
      </ScrollView>
      {tool && floorId ? (
        <Management
          key={`${floorId}:${tool.id}:${JSON.stringify(tool.args)}`}
          tool={tool.id}
          floor={floorId}
          params={tool.args}
          onEvent={(e) => {
            if (e.kind === 'close') session.closeTool();
            else session.managementEvent(e);
          }}
          style={{ flex: 1 }}
        />
      ) : (
        <ScrollView style={{ padding: 16 }} contentContainerStyle={{ gap: 8 }}>
          <Text style={s.muted}>{floorId ? 'Choose a tool. Your panes and drafts stay as they are.' : 'Waiting for the office…'}</Text>
          <Label>Only on the office’s own computer</Label>
          {NOT_OFFERED.map((n) => (
            <Text key={n.id} style={s.muted}>
              {n.label}: {n.reason}
            </Text>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function Device({ host, session, snap }: { host: MobileHost; session: Session; snap: ReturnType<Session['snapshot']> }) {
  return (
    <ScrollView style={{ padding: 12 }} contentContainerStyle={{ gap: 10 }} testID="device">
      <Label>Offices</Label>
      {snap.offices.offices.map((o) => (
        <Row key={o.id}>
          <Text style={[s.text, { flex: 1 }]}>
            {o.name}
            {o.where ? <Text style={s.muted}> · {o.where}</Text> : null}
          </Text>
          {o.id === snap.offices.active ? <Text style={s.muted}>This office</Text> : <Button small label="Switch" onPress={() => host.selectOffice(o.id)} testID={`office-${o.id}`} />}
        </Row>
      ))}
      <Row wrap>
        <Button label="Pair another office" onPress={() => host.openPairing()} />
        <Button label="Manage offices" onPress={() => host.openOffices()} />
        <Button label="Phone settings and alerts" onPress={() => host.openSettings()} />
      </Row>
      <Text style={s.muted}>
        Connection: {snap.link.phase}
        {session.ready() ? '' : snap.link.phase === 'connected' ? ' · waiting for the office' : ''}
      </Text>
    </ScrollView>
  );
}

function Toasts({ session, snap }: { session: Session; snap: ReturnType<Session['snapshot']> }) {
  if (!snap.office.toasts.length) return null;
  return (
    <View style={{ position: 'absolute', left: 8, right: 8, bottom: 8, gap: 4 }} pointerEvents="box-none">
      {snap.office.toasts.map((t) => (
        <Pressable
          key={t.id}
          onPress={() => session.dismissToast(t.id)}
          style={{ backgroundColor: colors.raised, borderLeftWidth: 3, borderColor: t.level === 'info' ? colors.info : t.level === 'warn' ? colors.warn : colors.danger, padding: 8, borderRadius: 4 }}
        >
          <Text style={s.text}>{t.text}</Text>
        </Pressable>
      ))}
    </View>
  );
}

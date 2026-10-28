import { useEffect, useState } from 'react';
import { Image, Modal, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { PROMPT_IMAGES_MAX } from '../../shared/drops';
import { AGENT_EFFORTS, type AgentEffort } from '../../shared/protocol';
import { availabilityOf } from '../../client/ui/model-search';
import { canWorktree, currentFloor } from '../office-state';
import type { Session, SessionSnapshot } from '../session';
import { Button, Chip, colors, Label, Note, Row, s } from './kit';

interface CatalogueModel {
  id: string;
  displayName: string;
  supportedReasoningEfforts?: AgentEffort[];
  defaultReasoningEffort?: AgentEffort;
}

/** Hires a Droid or opens a shell on the current floor, at its first free seat. */
export function HireSheet({ session, snap, onClose }: { session: Session; snap: SessionSnapshot; onClose: () => void }) {
  const floor = currentFloor(snap.office);
  const [kind, setKind] = useState<'agent' | 'shell'>('agent');
  const [prompt, setPrompt] = useState('');
  const [worktree, setWorktree] = useState(canWorktree(floor));
  const [models, setModels] = useState<CatalogueModel[] | undefined>();
  const [modelError, setModelError] = useState('');
  const [model, setModel] = useState<string | undefined>();
  const [effort, setEffort] = useState<AgentEffort | undefined>();
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // The token this sheet opened under: a hire is refused once the floor or socket changes.
  const [token] = useState(() => session.token());
  // Closing the sheet any way (Cancel, back, a floor change unmounting it) forgets unsent pictures.
  useEffect(() => () => session.discardHire(), [session]);
  const pictures = snap.hire?.images ?? [];
  const picking = session.isPickingHire();
  useEffect(() => {
    let live = true;
    session.host
      .http({ method: 'GET', path: '/api/agents/droid/models' })
      .then((r) => {
        if (!live) return;
        const list = (r.body as { models?: unknown } | undefined)?.models;
        if (r.status === 200 && Array.isArray(list)) setModels(list as CatalogueModel[]);
        else setModelError('Could not load Droid models. The office default is used.');
      })
      .catch(() => live && setModelError('Could not load Droid models. The office default is used.'));
    return () => {
      live = false;
    };
  }, [session]);
  const hidden = new Set(snap.office.hiddenModels);
  const shown = (models ?? []).filter((m) => !hidden.has(m.id) && (!query.trim() || `${m.displayName} ${m.id}`.toLowerCase().includes(query.trim().toLowerCase()))).slice(0, 40);
  const chosen = models?.find((m) => m.id === model);
  const efforts = chosen?.supportedReasoningEfforts ?? AGENT_EFFORTS;
  const why = (id: string) => (snap.office.subscriptions ? availabilityOf(id, snap.office.subscriptions, Date.now()).reason : undefined);
  // A shell sends no model, so a model that can't run doesn't stop it.
  const modelRefusal = kind === 'agent' && model ? why(model) : undefined;
  let refusal: string | undefined;
  if (!session.ready()) refusal = 'Disconnected. Nothing can be sent.';
  else if (!session.valid(token)) refusal = 'The office changed since this opened. Close and open Hire again.';
  else refusal = modelRefusal;
  const go = async () => {
    setPending(true);
    setError('');
    const withPictures = kind === 'agent' && pictures.length > 0;
    let r: Awaited<ReturnType<Session['hire']>>;
    try {
      r = await session.hire({ kind, prompt, worktree: worktree && canWorktree(floor), model, effort }, token);
    } finally {
      setPending(false);
    }
    if (r.ok) {
      onClose();
      session.toast(kind === 'shell' ? 'Shell opened.' : 'Droid hired.');
    } else setError(`${r.error ?? 'The office did not confirm the hire. Check the floor before trying again.'}${withPictures ? ' Attach the pictures again to retry.' : ''}`);
  };
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <ScrollView style={s.sheet} contentContainerStyle={{ gap: 10 }} testID="hire-sheet" keyboardShouldPersistTaps="handled">
        <Row>
          <Text style={[s.title, { flex: 1 }]}>{kind === 'shell' ? 'Open a shell' : 'Hire Droid'}</Text>
          <Button small tone="ghost" label="Cancel" onPress={onClose} />
        </Row>
        <Text style={s.muted}>{floor?.name ?? 'No floor'} · first free seat</Text>
        <Row>
          <Chip label="Droid" on={kind === 'agent'} onPress={() => setKind('agent')} testID="hire-agent" />
          <Chip label="Shell" on={kind === 'shell'} onPress={() => setKind('shell')} testID="hire-shell" />
        </Row>
        <TextInput
          testID="hire-prompt"
          style={[s.input, { minHeight: 90 }]}
          multiline
          maxLength={20000}
          value={prompt}
          onChangeText={setPrompt}
          placeholder={kind === 'shell' ? 'A first command (optional)' : 'What should it work on? (optional)'}
          placeholderTextColor={colors.muted}
        />
        {kind === 'agent' ? (
          <View style={{ gap: 6 }} testID="hire-pictures">
            {pictures.length ? (
              <ScrollView horizontal>
                {pictures.map((p, i) => (
                  <View key={p.id} style={{ marginRight: 6, alignItems: 'center' }}>
                    {p.preview ? <Image source={{ uri: p.preview }} style={{ width: 48, height: 48, borderRadius: 4 }} /> : <View style={{ width: 48, height: 48, backgroundColor: colors.raised }} />}
                    <Button small tone="ghost" label={`✕ ${i + 1}`} accessibilityLabel={`Remove image ${i + 1}`} disabled={pending} onPress={() => session.removeHireImage(p.id)} />
                  </View>
                ))}
              </ScrollView>
            ) : null}
            <Button
              small
              tone="ghost"
              label={picking ? 'Attaching…' : `Pictures${pictures.length ? ` · ${pictures.length}/${PROMPT_IMAGES_MAX}` : ''}`}
              disabled={pending || picking || !!refusal || pictures.length >= PROMPT_IMAGES_MAX}
              onPress={() => void session.attachHire()}
              testID="hire-attach"
            />
          </View>
        ) : pictures.length ? (
          <Text style={s.muted}>A shell takes no pictures; they are dropped when it opens.</Text>
        ) : null}
        {canWorktree(floor) ? (
          <Row>
            <Switch value={worktree} onValueChange={setWorktree} testID="hire-worktree" />
            <Text style={s.text}>Its own git worktree</Text>
          </Row>
        ) : (
          <Text style={s.muted}>This floor has no branch to cut a worktree from: it works in the checkout.</Text>
        )}
        {kind === 'agent' ? (
          <View style={{ gap: 6 }}>
            <Label>Model</Label>
            <TextInput style={s.input} value={query} onChangeText={setQuery} placeholder="Search models" placeholderTextColor={colors.muted} />
            <Chip label="Office default" on={!model} onPress={() => (setModel(undefined), setEffort(undefined))} />
            {modelError ? <Note tone="warn">{modelError}</Note> : !models ? <Text style={s.muted}>Loading Droid models…</Text> : null}
            {shown.map((m) => {
              const reason = why(m.id);
              return (
                <View key={m.id}>
                  <Chip label={m.displayName} on={model === m.id} disabled={!!reason} onPress={() => (setModel(m.id), setEffort(undefined))} testID={`hire-model-${m.id}`} />
                  {reason ? <Text style={s.muted}>{reason}</Text> : null}
                </View>
              );
            })}
            <Label>Effort</Label>
            <Row wrap>
              <Chip label="Default" on={!effort} onPress={() => setEffort(undefined)} />
              {efforts.map((e) => (
                <Chip key={e} label={e} on={effort === e} onPress={() => setEffort(e)} testID={`hire-effort-${e}`} />
              ))}
            </Row>
          </View>
        ) : null}
        {snap.office.subagents && !snap.office.subagents.on ? <Text style={s.muted}>Subagent hiring is off for workers; you can still hire here.</Text> : null}
        {refusal || error ? <Note tone="warn">{error || refusal}</Note> : null}
        <Button tone="primary" label={pending ? 'Hiring…' : kind === 'shell' ? 'Open shell' : 'Hire Droid'} disabled={pending || picking || !!refusal} onPress={() => void go()} testID="hire-submit" />
      </ScrollView>
    </Modal>
  );
}

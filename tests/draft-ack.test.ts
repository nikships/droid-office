import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledgeDraft, SubmittedDrafts, type SubmittedDraft } from '../src/client/draft-ack.js';
import { ImageStaging } from '../src/client/image-staging.js';

test('dispose, remount, edit and add a picture, then the old send succeeds: only what it sent leaves the draft', async () => {
  const staging = new ImageStaging<string>({ upload: async (_floor, file) => `id-${file}`, forget: () => {} });
  const acks = new SubmittedDrafts();
  // The workspace's kept draft for this worker, as the adapter stores it.
  let draft = { text: 'Fix the bug', attachments: [] as string[] };
  const old = staging.stage('a', 'old.png');
  await old.settled;
  draft = { ...draft, attachments: [old.handle] };
  // The old view sends; before the receipt comes back, the pane is closed and opened again.
  const outgoing: SubmittedDraft = { text: draft.text, attachments: [old.handle] };
  staging.keep(old.handle);
  // The remounted view adopts the kept picture, and the owner edits and adds another.
  staging.adopt(old.handle);
  const added = staging.stage('a', 'new.png');
  await added.settled;
  let liveText = 'Fix the bug, and the test';
  draft = { text: liveText, attachments: [old.handle, added.handle] };
  const onDraft: string[] = [];
  const off = acks.on('key', (sent) => {
    if (liveText !== sent.text) return;
    liveText = '';
    onDraft.push('');
  });
  // The old send succeeds: it takes its pictures, tells the remount, and the adapter acknowledges.
  assert.equal(staging.take(old.handle), 'id-old.png');
  acks.emit('key', outgoing);
  draft = acknowledgeDraft(draft, outgoing);
  assert.deepEqual(draft, { text: 'Fix the bug, and the test', attachments: [added.handle] }, 'the newer text and picture stay');
  assert.equal(liveText, 'Fix the bug, and the test', 'the live composer keeps its edit');
  assert.deepEqual(onDraft, []);
  assert.equal(staging.adopt(added.handle)?.id, 'id-new.png', 'the new picture is still staged for the next send');
  assert.equal(staging.adopt(old.handle), undefined, 'the sent picture cannot go again');
  off();
});

test('an unchanged remounted draft is cleared by the old send, and its view clears its composer', () => {
  const acks = new SubmittedDrafts();
  let liveText = 'Ship it';
  const cleared: string[] = [];
  const mine = (sent: SubmittedDraft) => cleared.push(`sender:${sent.text}`);
  acks.on('key', mine);
  acks.on('key', (sent) => {
    if (liveText !== sent.text) return;
    liveText = '';
    cleared.push('remount');
  });
  acks.on('other-key', () => cleared.push('other worker'));
  const sent = { text: 'Ship it', attachments: ['img-1'] };
  acks.emit('key', sent, mine);
  assert.deepEqual(cleared, ['remount'], 'not the sender itself, not another draft');
  assert.equal(liveText, '');
  assert.deepEqual(acknowledgeDraft({ text: 'Ship it', attachments: ['img-1', 'img-2'] }, sent), { text: '', attachments: ['img-2'] });
});

test('acknowledging keeps the same object when nothing it sent is still in the draft', () => {
  const draft = { text: 'newer', attachments: ['img-9'], extra: true };
  assert.equal(acknowledgeDraft(draft, { text: 'older', attachments: ['img-1'] }), draft);
  assert.deepEqual(acknowledgeDraft(draft, { text: 'newer', attachments: [] }), { text: '', attachments: ['img-9'], extra: true });
});

test('listeners leave their key when unsubscribed', () => {
  const acks = new SubmittedDrafts();
  const off = acks.on('key', () => assert.fail('unsubscribed'));
  off();
  acks.emit('key', { text: '', attachments: [] });
  assert.equal(acks.size, 0);
});

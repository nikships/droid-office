import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_KEY, DASHBOARD_WORKSPACE_KEY, clearBrowserDrafts, draftKey } from '../src/client/browser-session.js';

test('disconnect drops legacy drafts on every floor but preserves layout, credentials and submitted receipts', () => {
  const first = draftKey('first', 'same');
  const second = draftKey('second', 'same');
  const answer = draftKey('second', 'same:answer');
  const hire = draftKey('first', 'hire:agent');
  const data = new Map([
    [first, 'one'],
    [second, 'two'],
    [answer, 'choice'],
    [hire, 'task'],
    [`${first}:queue-receipts`, 'submitted'],
    [BROWSER_KEY, 'credential'],
    [DASHBOARD_WORKSPACE_KEY, 'layout'],
  ]);
  const storage = {
    get length() {
      return data.size;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
  clearBrowserDrafts(storage);
  assert.deepEqual(
    [...data],
    [
      [`${first}:queue-receipts`, 'submitted'],
      [BROWSER_KEY, 'credential'],
      [DASHBOARD_WORKSPACE_KEY, 'layout'],
    ],
  );
  clearBrowserDrafts(storage);
  assert.equal(data.size, 3);
});

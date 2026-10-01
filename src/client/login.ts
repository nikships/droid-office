import { RETURN_PARAM, safeReturnTo } from '../shared/return-to';
import { mountKeyboard } from './native/keyboard';
import { isNativePath } from './native/mode';

const next = safeReturnTo(new URLSearchParams(location.search).get(RETURN_PARAM));
// Signing in on a headset's panel: its own keyboard, since there may be no other.
if (isNativePath(next)) {
  document.body.classList.add('native-xr');
  mountKeyboard();
}

const form = document.getElementById('form') as HTMLFormElement;
const nameRow = document.getElementById('name-row') as HTMLLabelElement;
const nameInput = document.getElementById('name') as HTMLInputElement;
const nameNote = document.getElementById('name-note') as HTMLParagraphElement;
const sub = document.getElementById('sub') as HTMLParagraphElement;
const input = document.getElementById('password') as HTMLInputElement;
const error = document.getElementById('error') as HTMLParagraphElement;
const submit = document.getElementById('submit') as HTMLButtonElement;

const NAME_KEY = 'droid-office.login-name';

// Ask for a name once people have accounts; it's optional while the shared password still works.
void fetch('/api/login', { cache: 'no-store' })
  .then((r) => r.json())
  .then(({ accounts, shared }: { accounts: boolean; shared: boolean }) => {
    if (!accounts && shared) return;
    nameRow.hidden = false;
    nameInput.required = !shared;
    nameNote.hidden = !shared;
    sub.textContent = shared ? 'Knock knock. Who is it?' : 'Knock knock. Who is it? Sign in with your own account.';
    try {
      nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      // storage blocked
    }
    (nameInput.value ? input : nameInput).focus();
  })
  .catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  submit.disabled = true;
  const name = nameRow.hidden ? '' : nameInput.value.trim();
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, password: input.value }),
    });
    if (res.ok) {
      try {
        localStorage.setItem(NAME_KEY, name);
      } catch {
        // storage blocked
      }
      location.href = next;
      return;
    }
    const body = await res.json().catch(() => ({}));
    error.textContent = body.error ?? 'Could not sign in';
    input.select();
  } catch {
    error.textContent = 'Server unreachable';
  } finally {
    submit.disabled = false;
  }
});

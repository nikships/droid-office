// The browser's "Leave site?" prompt, so Cmd+W or a stray reload doesn't drop you out of the
// office. The office's own reload (loading an upgrade) goes through reloadPage, which skips it.

let leaving = false;

/** Asks before the page closes or reloads. Browsers only ask once you've clicked or typed in the page. */
export function guardLeaving() {
  window.addEventListener('beforeunload', (e) => {
    if (leaving) return;
    e.preventDefault();
    // Safari and older Chrome ask only when returnValue is set.
    e.returnValue = '';
  });
}

export function reloadPage() {
  leaving = true;
  location.reload();
}

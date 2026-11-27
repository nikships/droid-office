// Keep the failure path readable by the stock WebView on the oldest Android we
// support. An unsupported module syntax fails before its own code can report it.
import('./terminal.js').then((page) => page.start()).catch(() => window.OfficeBridge.post('{"t":"unavailable"}'));

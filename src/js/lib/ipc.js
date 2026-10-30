// The only bridge to Rust: commands via invoke, live updates via the event bus.

const T = window.__TAURI__;

export class AppError extends Error {
  constructor(message, code, hint) {
    super(message);
    this.code = code || 'error';
    this.hint = hint || null;
  }
}

function toError(e) {
  if (e instanceof AppError) return e;
  if (e && typeof e === 'object' && 'message' in e) return new AppError(e.message, e.code, e.hint);
  return new AppError(String(e));
}

/** Calls a Rust command. Rejects with AppError { message, code, hint }. */
export async function call(cmd, args = {}) {
  if (!T) throw new AppError('Not running inside the iQuantize app', 'no_tauri');
  try {
    return await T.core.invoke(cmd, args);
  } catch (e) {
    throw toError(e);
  }
}

/** Subscribes to a Rust event; returns a synchronous unsubscribe function. */
export function on(event, fn) {
  if (!T) return () => {};
  let unlisten = null;
  let dead = false;
  T.event
    .listen(event, (ev) => fn(ev.payload))
    .then((u) => {
      if (dead) u();
      else unlisten = u;
    });
  return () => {
    dead = true;
    if (unlisten) unlisten();
  };
}

/** Collects several unsubscribe/cleanup functions into one. */
export function disposer() {
  const fns = [];
  const d = (fn) => {
    if (typeof fn === 'function') fns.push(fn);
    return fn;
  };
  d.dispose = () => {
    while (fns.length) {
      try {
        fns.pop()();
      } catch (e) {
        console.error(e);
      }
    }
  };
  return d;
}

// Minimal observable store.

export function store(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      for (const fn of subs) fn(value);
    },
    patch(partial) {
      this.set({ ...value, ...partial });
    },
    sub(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** App-wide state shared by the shell and views. */
export const app = store({
  info: null, // app_info()
  settings: {}, // settings_get()
  theme: 'dark', // resolved theme
  jobs: new Map(), // id -> job row (live)
  inspectorOpen: false,
  sidebarCollapsed: false,
});

export function activeJobs() {
  return [...app.get().jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued');
}

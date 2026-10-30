// Model library + "Add from Hugging Face" browser + local folder import.

import { badge, button, callout, empty } from '../components/controls.js';
import { infoIcon } from '../components/info.js';
import { jobCard } from '../components/jobs.js';
import { openModal, showError, toast } from '../components/overlay.js';
import { clear, debounce, h, icon } from '../lib/dom.js';
import { ago, bytes, compact, num, params as fmtParams } from '../lib/format.js';
import { call, disposer, on } from '../lib/ipc.js';
import { go, setCrumbs } from '../lib/router.js';

const STARTERS = [
  { id: 'HuggingFaceTB/SmolLM2-135M-Instruct', size: '135M', why: 'Tiny, every step finishes in minutes. Great for a first try.' },
  { id: 'Qwen/Qwen2.5-0.5B-Instruct', size: '0.5B', why: 'Small multilingual chat model.' },
  { id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', size: '1.7B', why: 'Capable small model; outputs are easier to judge.' },
  { id: 'Qwen/Qwen3-4B', size: '4B', why: 'Strong mid-size model.' },
  { id: 'meta-llama/Llama-3.2-1B-Instruct', size: '1B', why: 'Gated: accept the licence on Hugging Face first.', gated: true },
];

const SORTS = [
  ['downloads', 'Most downloaded'],
  ['trendingScore', 'Trending'],
  ['likes', 'Most liked'],
  ['lastModified', 'Recently updated'],
];

const SIZES = [
  ['any', 'Any size', () => true],
  ['xs', '< 1B', (p) => p < 1e9],
  ['s', '1–4B', (p) => p >= 1e9 && p < 4.5e9],
  ['m', '4–14B', (p) => p >= 4.5e9 && p < 15e9],
  ['l', '14B+', (p) => p >= 15e9],
];

// Results load a page at a time as you scroll, up to a cap that keeps the list quick to scan.
const PAGE = 50;
const MAX_RESULTS = 100;

const COMPAT_LABEL = { yes: 'Supported', warn: 'Check notes', no: 'Not supported', unknown: 'Tools not installed' };
const COMPAT_ICON = { yes: 'circle-check', warn: 'triangle-alert', no: 'circle-x', unknown: 'circle-help' };
const TONES = ['accent', 'info', 'violet', 'teal', 'orange', 'pink', 'blue', 'green'];

export function compatDots(compat) {
  if (!compat) return null;
  const kind = { yes: 'success', warn: 'warning', no: 'danger', unknown: '' };
  return h(
    'span',
    { class: 'compat' },
    ['gguf', 'mlx', 'onnx'].map((f) => {
      const c = compat[f] || { status: 'unknown' };
      const b = badge(f.toUpperCase(), kind[c.status] || '');
      b.title = c.reason || '';
      return b;
    }),
  );
}

/** Owner initials on a colour picked from the owner name, so the same publisher always looks the same. */
function hubAvatar(id, size = '') {
  const owner = id.split('/')[0] || id;
  let hash = 0;
  for (const ch of owner) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const initials = owner.replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?';
  return h('span', { class: `hub-avatar tone-${TONES[hash % TONES.length]} ${size}` }, initials.toUpperCase());
}

function repoName(id) {
  const [owner, ...rest] = id.split('/');
  return h('span', { class: 'hub-name ellipsis' }, rest.length ? [h('span', { class: 'owner' }, `${owner}/`), rest.join('/')] : id);
}

/** "today", "5 days ago", "3 mo ago", "2 yr ago" from an ISO date. */
function updated(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!iso || Number.isNaN(days)) return null;
  if (days < 1) return 'today';
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 365) return `${Math.round(days / 30.4)} mo ago`;
  return `${Math.round(days / 365)} yr ago`;
}

function skeletonRows(n) {
  return Array.from({ length: n }, () => h('div', { class: 'hub-row skeleton' }, h('span', { class: 'hub-avatar' }), h('div', { class: 'grow col gap-1' }, h('i', { class: 'bar w60' }), h('i', { class: 'bar w40' }))));
}

export function addFromHubModal({ onStarted } = {}) {
  const state = { query: '', sort: 'downloads', size: 'any', quantized: false, items: [], cursor: null, selected: null, focus: -1, library: new Map(), diskFree: null };
  const input = h('input', { class: 'input', type: 'search', spellcheck: 'false', placeholder: 'Search models, or paste an id like owner/name' });
  const listEl = h('div', { class: 'hub-list' });
  const detailEl = h('div', { class: 'hub-detail' });
  const sortBar = h('div', { class: 'hub-chips' });
  const sizeBar = h('div', { class: 'hub-chips' });
  const quantChip = h('button', { class: 'chip', onClick: () => ((state.quantized = !state.quantized), renderList()) });
  let rows = [];
  let downloadBtn = null;
  let modal;
  let searchToken = 0;

  // What's already in the library, and how much room there is for a download.
  call('models_list')
    .then((ms) => {
      for (const m of ms) if (m.repo_id) state.library.set(m.repo_id, m);
      renderList();
    })
    .catch(() => {});
  call('system_stats')
    .then((st) => (state.diskFree = st.disk_free ?? null))
    .catch(() => {});

  /* ---------- Filters ---------- */

  const renderChips = () => {
    clear(sortBar).append(
      h('span', { class: 'hub-chip-label' }, 'Sort'),
      SORTS.map(([v, label]) => h('button', { class: `chip ${state.sort === v ? 'on' : ''}`, onClick: () => ((state.sort = v), renderChips(), runSearch()) }, label)),
    );
    clear(sizeBar).append(
      h('span', { class: 'hub-chip-label' }, 'Size'),
      SIZES.map(([v, label]) => h('button', { class: `chip ${state.size === v ? 'on' : ''}`, onClick: () => ((state.size = v), renderChips(), renderList()) }, label)),
    );
  };

  const visible = () => {
    const fits = SIZES.find(([v]) => v === state.size)[2];
    return state.items.filter((m) => (state.quantized || !m.already_quantized) && (state.size === 'any' || (m.params && fits(m.params))));
  };

  /* ---------- List ---------- */

  const libraryBadge = (id) => {
    const m = state.library.get(id);
    if (!m) return null;
    return m.status === 'ready' ? badge('In library', 'success', 'check') : m.status === 'downloading' ? badge('Downloading', 'accent') : badge('Download failed', 'danger');
  };

  const resultRow = (m) =>
    h(
      'button',
      { class: `hub-row ${state.selected === m.id ? 'on' : ''}`, data: { id: m.id }, onClick: () => select(m.id) },
      hubAvatar(m.id),
      h(
        'div',
        { class: 'grow col' },
        h('div', { class: 'row' }, repoName(m.id), m.gated ? icon('lock', 'xs warning-text') : null),
        h(
          'div',
          { class: 'hub-meta' },
          m.params ? h('span', { class: 'pill' }, fmtParams(m.params)) : null,
          m.license ? h('span', null, m.license) : null,
          h('span', { title: `${num(m.downloads, 0)} downloads` }, icon('download', 'xs'), compact(m.downloads)),
          m.likes ? h('span', { title: `${num(m.likes, 0)} likes` }, icon('heart', 'xs'), compact(m.likes)) : null,
          m.last_modified ? h('span', null, updated(m.last_modified)) : null,
        ),
      ),
      libraryBadge(m.id) || (m.already_quantized ? badge('Quantized', 'outline') : null),
    );

  const starterCard = (st) =>
    h(
      'button',
      { class: `hub-row starter ${state.selected === st.id ? 'on' : ''}`, data: { id: st.id }, onClick: () => ((input.value = ''), select(st.id)) },
      hubAvatar(st.id),
      h('div', { class: 'grow col' }, h('div', { class: 'row' }, repoName(st.id), st.gated ? icon('lock', 'xs warning-text') : null), h('div', { class: 'hub-why' }, st.why)),
      libraryBadge(st.id) || h('span', { class: 'pill' }, st.size),
    );

  const more = () => state.cursor && state.items.length < MAX_RESULTS;
  const nearEnd = () => listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 240;

  const renderList = () => {
    const shown = visible();
    const hidden = state.items.filter((m) => m.already_quantized).length;
    quantChip.classList.toggle('on', state.quantized);
    clear(quantChip).append(state.quantized ? icon('check', 'xs') : null, `Include quantized${hidden ? ` (${hidden})` : ''}`);
    const top = listEl.scrollTop;
    clear(listEl);
    if (!state.query) {
      listEl.append(h('div', { class: 'hub-section' }, icon('sparkles', 'xs'), 'Good starting points'), STARTERS.map(starterCard));
      listEl.append(h('div', { class: 'hub-section' }, icon('activity', 'xs'), `Popular on Hugging Face · ${SORTS.find(([v]) => v === state.sort)[1].toLowerCase()}`));
    } else {
      listEl.append(h('div', { class: 'hub-section' }, `${shown.length}${more() ? '+' : ''} result${shown.length === 1 && !more() ? '' : 's'}`, !state.quantized && hidden ? h('span', { class: 'muted' }, ` · ${hidden} quantized hidden`) : null));
    }
    if (state.loading) listEl.append(skeletonRows(6));
    else if (state.error) listEl.append(callout('danger', 'circle-x', h('div', null, state.error.message, state.error.hint ? h('div', { class: 'small' }, state.error.hint) : null)));
    else if (!shown.length)
      listEl.append(
        h('div', { class: 'hub-empty' }, icon('search'), h('div', null, 'No text-generation models match.'), h('div', { class: 'muted small' }, 'Try fewer words, another size, or paste the exact owner/name.')),
      );
    else listEl.append(shown.map(resultRow));
    if (!state.loading && !state.error) {
      if (state.loadingMore) listEl.append(skeletonRows(2));
      else if (state.moreError) listEl.append(h('div', { class: 'hub-end' }, 'Could not load more results. ', h('a', { onClick: loadMore }, 'Try again')));
      else if (state.items.length >= MAX_RESULTS && state.cursor) listEl.append(h('div', { class: 'hub-end' }, `Showing the top ${MAX_RESULTS}. Refine your search to find others.`));
    }
    rows = [...listEl.querySelectorAll('.hub-row:not(.skeleton)')];
    state.focus = rows.findIndex((r) => r.dataset.id === state.selected);
    listEl.scrollTop = top;
    // If filters leave too few rows to scroll, keep fetching pages until the list fills up.
    if (!state.loading && !state.loadingMore && !state.moreError && more() && nearEnd()) requestAnimationFrame(loadMore);
  };

  const loadMore = async () => {
    if (!more() || state.loading || state.loadingMore) return;
    const my = searchToken;
    state.loadingMore = true;
    state.moreError = null;
    renderList();
    try {
      const page = await call('hub_search', { query: state.query, sort: state.sort, limit: Math.min(PAGE, MAX_RESULTS - state.items.length), cursor: state.cursor });
      if (my !== searchToken) return;
      const seen = new Set(state.items.map((m) => m.id));
      state.items = [...state.items, ...page.items.filter((m) => !seen.has(m.id))];
      state.cursor = page.cursor;
    } catch (e) {
      if (my !== searchToken) return;
      state.moreError = e;
    }
    state.loadingMore = false;
    renderList();
  };
  listEl.addEventListener('scroll', () => {
    if (nearEnd()) loadMore();
  });

  const runSearch = async () => {
    const my = ++searchToken;
    state.loading = true;
    state.loadingMore = false;
    state.error = null;
    state.moreError = null;
    renderList();
    listEl.scrollTop = 0;
    try {
      const page = await call('hub_search', { query: state.query, sort: state.sort, limit: PAGE });
      if (my !== searchToken) return;
      state.items = page.items;
      state.cursor = page.cursor;
    } catch (e) {
      if (my !== searchToken) return;
      state.items = [];
      state.cursor = null;
      state.error = e;
    }
    state.loading = false;
    renderList();
  };
  const searchSoon = debounce(runSearch, 300);

  input.addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    if (/^[\w.-]+\/[\w.-]+$/.test(state.query)) select(state.query);
    searchSoon();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      state.focus = Math.max(0, Math.min(rows.length - 1, state.focus + (e.key === 'ArrowDown' ? 1 : -1)));
      rows[state.focus].scrollIntoView({ block: 'nearest' });
      selectSoon(rows[state.focus].dataset.id);
      rows.forEach((r, i) => r.classList.toggle('on', i === state.focus));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && downloadBtn && !downloadBtn.disabled) downloadBtn.click();
      else if (rows[state.focus]) select(rows[state.focus].dataset.id);
    }
  });

  /* ---------- Detail ---------- */

  const placeholder = () =>
    h(
      'div',
      { class: 'hub-placeholder' },
      h('span', { class: 'help-tile tone-accent lg' }, icon('box')),
      h('h3', null, 'Pick a model to see if it will convert'),
      h('p', null, 'You will see its size, architecture and licence, and whether GGUF, MLX and ONNX can handle it, before downloading anything.'),
      h('ul', null, h('li', null, 'Start from the original BF16 or FP16 weights, not a quantized repository.'), h('li', null, 'Paste an exact id such as ', h('code', null, 'Qwen/Qwen3-4B'), ' to jump straight to it.')),
    );

  const stat = (label, value, info) => h('div', { class: 'hub-stat' }, h('div', { class: 'label' }, label, info ? infoIcon(info) : null), h('div', { class: 'value' }, value));

  const formatCard = (format, c = { status: 'unknown' }) =>
    h(
      'div',
      { class: `hub-format ${c.status}` },
      h('div', { class: 'row' }, icon(COMPAT_ICON[c.status] || 'circle-help', 'sm'), h('b', null, format.toUpperCase()), infoIcon(`format.${format}`)),
      h('div', { class: 'status' }, COMPAT_LABEL[c.status] || 'Unknown'),
      h('div', { class: 'reason' }, c.reason || ''),
    );

  const startDownload = async (m) => {
    try {
      const jobId = await call('model_download', { repoId: m.repo_id, revision: m.revision });
      toast('Download started', { kind: 'info', detail: m.repo_id });
      modal.close();
      onStarted?.(jobId);
    } catch (e) {
      showError(e, 'Could not start download');
    }
  };

  const actions = (m) => {
    const lib = state.library.get(m.repo_id);
    const tooBig = state.diskFree != null && m.download_bytes + 1e9 > state.diskFree;
    downloadBtn = button(lib?.status === 'error' ? 'Resume download' : lib ? 'Download again' : `Download ${bytes(m.download_bytes)}`, {
      // Only nudge towards downloading good starting points: originals with safetensors weights.
      kind: lib?.status === 'ready' || m.arch?.quantization || !m.has_safetensors ? '' : 'primary',
      iconName: 'download',
      disabled: lib?.status === 'downloading' || !m.download_files.length,
      onClick: () => startDownload(m),
    });
    return h(
      'div',
      { class: 'hub-foot' },
      h(
        'div',
        { class: 'grow col' },
        h('span', { class: tooBig ? 'warning-text' : '' }, `${bytes(m.download_bytes)} in ${m.download_files.length} files`, state.diskFree != null ? ` · ${bytes(state.diskFree)} free` : ''),
        h('span', { class: 'muted xs' }, tooBig ? 'Not enough free space: you need the download size plus 1 GB.' : 'Resumable, and checked against Hugging Face’s SHA-256 checksums.'),
      ),
      lib?.status === 'ready' ? button('Open in library', { kind: 'primary', iconName: 'arrow-right', onClick: () => (modal.close(), go(`/models/${lib.id}`)) }) : null,
      downloadBtn,
    );
  };

  const renderDetail = (m) => {
    const a = m.arch || {};
    const lib = state.library.get(m.repo_id);
    const notes = [];
    if (m.gated)
      notes.push(callout('warning', 'lock', h('div', null, h('b', null, 'Gated model. '), 'Accept the licence on its Hugging Face page, and add a token in Settings → Accounts, before downloading. ', infoIcon('hub.gated'))));
    if (a.quantization)
      notes.push(callout('warning', 'triangle-alert', h('div', null, h('b', null, `Already quantized (${a.quantization}). `), 'Start from the original full-precision repository for best results. ', infoIcon('concept.already_quantized'))));
    if (!m.has_safetensors) notes.push(callout('warning', 'triangle-alert', 'No .safetensors weights in this repository. Conversion works best from the original safetensors weights.'));
    if (lib?.status === 'ready') notes.push(callout('success', 'circle-check', 'Already in your library. Download again to check its files, or open it.'));
    downloadBtn = null;
    const foot = actions(m);
    clear(detailEl).append(
      h(
        'div',
        { class: 'hub-detail-body' },
        h(
          'div',
          { class: 'hub-head' },
          hubAvatar(m.repo_id, 'lg'),
          h('div', { class: 'grow col' }, h('h2', null, repoName(m.repo_id)), h(
            'div',
            { class: 'hub-meta' },
            m.downloads != null ? h('span', null, icon('download', 'xs'), `${compact(m.downloads)} downloads`) : null,
            m.likes != null ? h('span', null, icon('heart', 'xs'), `${compact(m.likes)} likes`) : null,
            m.last_modified ? h('span', null, `Updated ${updated(m.last_modified)}`) : null,
          )),
          h('button', { class: 'btn sm', title: 'Open on Hugging Face', onClick: () => call('open_external', { url: `https://huggingface.co/${m.repo_id}` }) }, 'Hugging Face', icon('arrow-up-right', 'xs')),
        ),
        notes,
        h(
          'div',
          { class: 'hub-stats' },
          stat('Parameters', m.params ? fmtParams(m.params) : '—', 'concept.params'),
          stat('Download', bytes(m.download_bytes)),
          stat('Context', a.context_length ? `${num(a.context_length, 0)} tokens` : '—', 'concept.context_length'),
          stat('Precision', (a.torch_dtype || '—').toUpperCase().replace('FLOAT', 'F'), 'concept.dtype'),
        ),
        h('div', { class: 'hub-label' }, 'Format support'),
        h('div', { class: 'hub-formats' }, ['gguf', 'mlx', 'onnx'].map((f) => formatCard(f, m.compat?.[f]))),
        h('div', { class: 'hub-label' }, 'Details'),
        h(
          'dl',
          { class: 'kv hub-kv' },
          h('dt', null, 'Architecture'),
          h('dd', null, a.architecture || '—'),
          h('dt', null, 'Layers'),
          h('dd', null, a.layers ?? '—'),
          h('dt', null, 'License'),
          h('dd', null, m.license || 'not stated', ' ', infoIcon('concept.license')),
          m.base_model ? [h('dt', null, 'Base model'), h('dd', null, [].concat(m.base_model).join(', '))] : null,
          h('dt', null, 'Chat template'),
          h('dd', null, m.chat_template ? 'Included' : 'Not found'),
          h('dt', null, 'Revision'),
          h('dd', { class: 'mono xs' }, m.revision.slice(0, 12), ' ', infoIcon('hub.revision')),
        ),
      ),
      foot,
    );
  };

  const select = async (id) => {
    state.selected = id;
    rows.forEach((r) => r.classList.toggle('on', r.dataset.id === id));
    state.focus = rows.findIndex((r) => r.dataset.id === id);
    clear(detailEl).append(
      h('div', { class: 'hub-detail-body' }, h('div', { class: 'hub-head' }, hubAvatar(id, 'lg'), h('div', { class: 'grow col' }, h('h2', null, repoName(id)), h('div', { class: 'hub-meta' }, h('div', { class: 'spinner' }), 'Reading the repository…'))), h('div', { class: 'hub-stats' }, Array.from({ length: 4 }, () => h('div', { class: 'hub-stat skeleton' }, h('i', { class: 'bar w40' }), h('i', { class: 'bar w60' }))))),
    );
    try {
      const m = await call('hub_model_info', { repoId: id });
      if (state.selected === id) renderDetail(m);
    } catch (e) {
      if (state.selected !== id) return;
      clear(detailEl).append(h('div', { class: 'hub-detail-body' }, h('div', { class: 'hub-head' }, hubAvatar(id, 'lg'), h('h2', { class: 'grow' }, repoName(id))), callout('danger', 'circle-x', h('div', null, e.message, e.hint ? h('div', { class: 'small' }, e.hint) : null))));
    }
  };
  const selectSoon = debounce(select, 160);

  modal = openModal({
    title: 'Add a model from Hugging Face',
    iconName: 'download',
    className: 'hub-modal',
    body: h(
      'div',
      { class: 'hub-browser' },
      h(
        'div',
        { class: 'hub-toolbar' },
        h('div', { class: 'input-with-icon hub-search' }, icon('search', 'sm'), input, h('span', { class: 'hub-keys' }, h('kbd', null, '↑'), h('kbd', null, '↓'), h('kbd', null, '↵'))),
        h('div', { class: 'row wrap gap-3' }, sortBar, h('span', { class: 'hub-sep' }), sizeBar, h('span', { class: 'hub-sep' }), quantChip),
      ),
      h('div', { class: 'hub-panes' }, listEl, detailEl),
    ),
  });
  clear(detailEl).append(placeholder());
  renderChips();
  runSearch();
  return modal;
}

export async function importLocal() {
  const path = await call('pick_folder', { title: 'Choose a model folder (with config.json and .safetensors)' });
  if (!path) return null;
  try {
    const m = await call('model_import_local', { path });
    toast('Model imported', { kind: 'success', detail: m.name });
    return m;
  } catch (e) {
    showError(e, 'Could not import this folder');
    return null;
  }
}

export default async function modelsView(root, { query }) {
  setCrumbs([]);
  const d = disposer();
  const view = h('div', { class: 'view' });
  root.appendChild(view);
  const jobsHost = h('div', { class: 'col gap-3', style: { marginBottom: '16px' } });
  const listHost = h('div');
  const watching = new Set();

  const watch = (id) => {
    if (watching.has(id)) return;
    watching.add(id);
    call('job_get', { id }).then((job) => {
      const card = jobCard(job, {
        showLog: true,
        onDone: (j) =>
          setTimeout(() => {
            if (j.status === 'done') {
              card.dispose();
              card.remove();
            }
            load();
          }, 1200),
      });
      d(card.dispose);
      jobsHost.appendChild(card);
    });
  };

  const load = async () => {
    let models = [];
    try {
      models = await call('models_list');
    } catch (e) {
      showError(e);
    }
    clear(listHost);
    if (!models.length) {
      listHost.appendChild(
        h(
          'div',
          { class: 'card' },
          empty({
            iconName: 'box',
            title: 'No models yet',
            text: 'Add an original (full-precision) model from Hugging Face, or import a folder you already have. Start small, e.g. a 0.1–2B model, to learn the flow quickly.',
            action: h('div', { class: 'row' }, button('Add from Hugging Face', { kind: 'primary', iconName: 'download', onClick: () => addFromHubModal({ onStarted: watch }) }), button('Import folder', { iconName: 'folder-open', onClick: () => importLocal().then(load) })),
          }),
        ),
      );
      return;
    }
    const details = await Promise.all(models.map((m) => call('model_get', { id: m.id }).catch(() => m)));
    listHost.appendChild(
      h(
        'div',
        { class: 'card list' },
        details.map((m) =>
          h(
            'div',
            { class: 'list-row model-row', onClick: () => go(`/models/${m.id}`) },
            h('div', { class: 'avatar' }, (m.name || '?').slice(0, 2).toUpperCase()),
            h(
              'div',
              { class: 'grow', style: { minWidth: '0' } },
              h('div', { class: 'title ellipsis' }, m.name),
              h('div', { class: 'meta ellipsis' }, [m.repo_id || m.local_path, m.params ? fmtParams(m.params) : null, m.dtype, m.size_bytes ? bytes(m.size_bytes) : null].filter(Boolean).join(' · ')),
            ),
            m.status === 'downloading' ? badge('Downloading', 'accent') : m.status === 'error' ? badge('Download failed', 'danger') : compatDots(m.compat),
            m.artifacts ? badge(`${m.artifacts} quantized`, 'accent') : null,
            h('span', { class: 'meta nowrap' }, ago(m.created_at)),
          ),
        ),
      ),
    );
  };

  view.append(
    h(
      'div',
      { class: 'view-head' },
      h('div', null, h('h1', null, 'Models'), h('div', { class: 'sub' }, 'Original models you can quantize. Downloads are resumable and verified against Hugging Face checksums.')),
      h(
        'div',
        { class: 'actions' },
        button('Import folder', { iconName: 'folder-open', onClick: () => importLocal().then(load) }),
        button('Add from Hugging Face', { kind: 'primary', iconName: 'download', onClick: () => addFromHubModal({ onStarted: watch }) }),
      ),
    ),
    jobsHost,
    listHost,
  );
  await load();
  d(on('models:changed', load));
  (await call('jobs_list', { kind: 'download', limit: 10 }).catch(() => [])).filter((j) => ['running', 'queued'].includes(j.status)).forEach((j) => watch(j.id));
  if (query.add === 'hf') addFromHubModal({ onStarted: watch });
  if (query.add === 'local') importLocal().then(load);
  return () => d.dispose();
}

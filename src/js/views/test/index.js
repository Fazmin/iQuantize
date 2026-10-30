// Test & Compare: side-by-side arena, prompt suites, and a quality/speed dashboard.

import { badge, button, callout, checkbox, dropdown, empty, numberField, segmented, slider, textField, toggle } from '../../components/controls.js';
import { infoIcon } from '../../components/info.js';
import { jobCard } from '../../components/jobs.js';
import { openModal, showError, toast } from '../../components/overlay.js';
import { legend, paretoFrontier, scatter } from '../../lib/charts.js';
import { wordDiff } from '../../lib/diff.js';
import { clear, h, icon } from '../../lib/dom.js';
import { bytes, fixed, pct } from '../../lib/format.js';
import { call, disposer, on } from '../../lib/ipc.js';
import { go, setCrumbs } from '../../lib/router.js';

const FORMAT_COLOR = { gguf: 'var(--series-1)', mlx: 'var(--series-2)', onnx: 'var(--series-3)' };

let lastTab = 'Arena';
const params = { temperature: 0, top_p: 1, max_tokens: 384, seed: 42, system: 'You are a helpful assistant.', sequential: false };

function artLabel(a, models) {
  const m = models.find((x) => x.id === a.model_id);
  return `${a.format.toUpperCase()} ${a.variant}${a.role === 'reference' ? ' (original)' : ''}${m ? ` · ${m.name}` : ''}`;
}

function artOptions(arts, models) {
  return arts.filter((a) => a.exists).map((a) => ({ value: a.id, label: artLabel(a, models), sub: `${bytes(a.size_bytes)}${a.bpw ? ` · ${a.bpw.toFixed(2)} bpw` : ''}`, group: models.find((m) => m.id === a.model_id)?.name || 'Other', info: a.role === 'reference' ? 'eval.reference' : `format.${a.format}` }));
}

/* ---------------- Arena ---------------- */

function arena(ctx) {
  const { arts, models, query, d } = ctx;
  const el = h('div', { class: 'col gap-3' });
  const usable = arts.filter((a) => a.exists);
  if (usable.length < 1) {
    el.appendChild(h('div', { class: 'card' }, empty({ iconName: 'flask-conical', title: 'Nothing to compare yet', text: 'Quantize a model first; the original and every quantized version appear here.', action: button('Quantize a model', { kind: 'primary', onClick: () => go('/quantize') }) })));
    return el;
  }
  let a = query.a && usable.find((x) => x.id === query.a) ? query.a : usable.find((x) => x.role !== 'reference')?.id || usable[0].id;
  const defaultB = () => {
    const A = usable.find((x) => x.id === a);
    return query.b && usable.find((x) => x.id === query.b) ? query.b : usable.find((x) => x.role === 'reference' && x.model_id === A?.model_id && x.format === A?.format)?.id || usable.find((x) => x.id !== a)?.id || a;
  };
  let b = defaultB();
  let stream = null;
  let turnId = null;
  const out = { a: '', b: '' };
  const panes = {};
  let diffOn = false;

  const pane = (side) => {
    const title = h('div', { class: 'grow ellipsis', style: { fontWeight: '600' } });
    const status = h('span', { class: 'small muted' });
    const text = h('div', { class: 'out' });
    const metrics = h('div', { class: 'metrics' });
    const card = h('div', { class: 'card arena-pane' }, h('div', { class: 'card-head' }, badge(side.toUpperCase(), 'accent'), title, status), text, metrics);
    panes[side] = { card, title, status, text, metrics };
    return card;
  };

  const renderTitles = () => {
    for (const side of ['a', 'b']) {
      const art = usable.find((x) => x.id === (side === 'a' ? a : b));
      panes[side].title.textContent = art ? artLabel(art, models) : '—';
    }
  };

  const renderText = () => {
    if (!diffOn || !out.a || !out.b) {
      for (const side of ['a', 'b']) panes[side].text.textContent = out[side];
      return;
    }
    const d = wordDiff(out.a, out.b);
    for (const side of ['a', 'b']) {
      const segs = d[side];
      const firstIdx = side === 'a' ? d.divergeA : d.divergeB;
      clear(panes[side].text).append(...segs.map((s, i) => h('span', { class: `${s.same ? '' : side === 'a' ? 'diff-del' : 'diff-add'} ${i === firstIdx ? 'diverge' : ''}`, title: i === firstIdx ? 'First point where the two answers differ' : null }, s.text)));
    }
  };

  const metricsRow = (side, m) => {
    clear(panes[side].metrics).append(
      h('span', null, 'First token ', h('b', null, `${fixed(m.ttft_ms, 0)} ms`), ' ', infoIcon('eval.ttft')),
      h('span', null, 'Speed ', h('b', null, `${fixed(m.tok_per_s, 1)} tok/s`), ' ', infoIcon('eval.speed_tg')),
      h('span', null, 'Tokens ', h('b', null, String(m.tokens))),
      m.prompt_tok_per_s ? h('span', null, 'Prompt ', h('b', null, `${fixed(m.prompt_tok_per_s, 0)} tok/s`), ' ', infoIcon('eval.speed_pp')) : null,
    );
  };

  const voteRow = h('div', { class: 'row hidden' }, h('span', { class: 'small muted' }, 'Which answer is better?'), infoIcon('eval.vote'));
  const votes = ['a', 'tie', 'b'].map((v) => button(v === 'tie' ? 'About the same' : `${v.toUpperCase()} is better`, { size: 'sm', onClick: () => turnId && call('arena_vote', { turnId, vote: v }).then(() => (votes.forEach((x) => x.classList.remove('primary')), votes[['a', 'tie', 'b'].indexOf(v)].classList.add('primary'))).catch(showError) }));
  voteRow.append(...votes);

  const prompt = h('textarea', { class: 'textarea', rows: 3, placeholder: 'Ask both models the same thing… (⌘/Ctrl + Enter to send)' });
  const sendBtn = button('Send to both', { kind: 'primary', iconName: 'send' });
  const stopBtn = button('Stop', { iconName: 'circle-stop' });
  stopBtn.classList.add('hidden');

  const send = async () => {
    const text = prompt.value.trim();
    if (!text) return;
    out.a = out.b = '';
    turnId = null;
    voteRow.classList.add('hidden');
    votes.forEach((x) => x.classList.remove('primary'));
    for (const side of ['a', 'b']) {
      panes[side].text.textContent = '';
      clear(panes[side].metrics);
      panes[side].status.textContent = 'Starting…';
    }
    try {
      stream = await call('arena_run', { a, b, prompt: text, system: params.system, paramsJson: { temperature: params.temperature, top_p: params.top_p, max_tokens: params.max_tokens, seed: params.seed }, sequential: params.sequential });
      sendBtn.disabled = true;
      stopBtn.classList.remove('hidden');
    } catch (e) {
      showError(e);
    }
  };
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => stream && call('arena_cancel', { stream }));
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
  });

  const doneSides = new Set();
  d(
    on('arena:status', (p) => {
      if (p.stream !== stream) return;
      if (p.sequential && !p.side) toast('Running one model at a time', { kind: 'info', detail: 'Both models together would not fit comfortably in free memory.' });
      if (p.side) panes[p.side].status.textContent = p.status === 'loading' ? 'Loading model…' : 'Generating…';
    }),
  );
  d(
    on('arena:delta', (p) => {
      if (p.stream !== stream) return;
      out[p.side] += p.text;
      if (!diffOn) panes[p.side].text.textContent = out[p.side];
    }),
  );
  d(
    on('arena:done', (p) => {
      if (p.stream !== stream) return;
      panes[p.side].status.textContent = 'Done';
      metricsRow(p.side, p.metrics);
      doneSides.add(p.side);
      renderText();
    }),
  );
  d(
    on('arena:error', (p) => {
      if (p.stream !== stream) return;
      panes[p.side].status.textContent = 'Failed';
      panes[p.side].text.appendChild(h('div', null, callout('danger', 'circle-x', h('div', null, p.message, p.hint ? h('div', { class: 'small' }, p.hint) : null))));
    }),
  );
  d(
    on('arena:saved', (p) => {
      if (p.stream !== stream) return;
      turnId = p.turn_id;
      sendBtn.disabled = false;
      stopBtn.classList.add('hidden');
      voteRow.classList.remove('hidden');
      doneSides.clear();
      renderText();
    }),
  );

  const opts = artOptions(arts, models);
  el.append(
    h(
      'div',
      { class: 'grid-2' },
      dropdown({ label: 'Model A', info: 'eval.reference', value: a, options: opts, onChange: (v) => ((a = v), renderTitles()) }),
      dropdown({ label: 'Model B', info: 'eval.reference', value: b, options: opts, onChange: (v) => ((b = v), renderTitles()) }),
    ),
    h(
      'details',
      { class: 'card pad' },
      h('summary', { style: { cursor: 'pointer', fontWeight: '600' } }, 'Generation settings'),
      h(
        'div',
        { class: 'col gap-3', style: { marginTop: '12px' } },
        h(
          'div',
          { class: 'grid-4' },
          slider({ label: 'Temperature', info: 'eval.temperature', min: 0, max: 1.5, step: 0.05, value: params.temperature, format: (v) => (v === 0 ? '0 (deterministic)' : v.toFixed(2)), onChange: (v) => (params.temperature = v) }),
          slider({ label: 'Top-p', info: 'eval.top_p', min: 0.1, max: 1, step: 0.05, value: params.top_p, format: (v) => v.toFixed(2), onChange: (v) => (params.top_p = v) }),
          numberField({ label: 'Max new tokens', info: 'eval.max_tokens', value: params.max_tokens, min: 16, max: 4096, onChange: (v) => (params.max_tokens = v) }),
          numberField({ label: 'Seed', info: 'eval.seed', value: params.seed, min: 0, max: 2 ** 31, onChange: (v) => (params.seed = v) }),
        ),
        textField({ label: 'System prompt', info: 'eval.system_prompt', value: params.system, multiline: true, rows: 2, onInput: (v) => (params.system = v) }),
        toggle({ label: 'Run one model at a time (saves memory)', info: 'eval.sequential', value: params.sequential, onChange: (v) => (params.sequential = v) }),
      ),
    ),
    h('div', { class: 'arena' }, pane('a'), pane('b')),
    h(
      'div',
      { class: 'row' },
      toggle({ label: 'Highlight differences', info: 'eval.divergence', value: diffOn, onChange: (v) => ((diffOn = v), renderText()) }),
      h('span', { class: 'spacer' }),
      voteRow,
    ),
    h('div', { class: 'card pad col gap-2' }, prompt, h('div', { class: 'row' }, ...['Explain quantization to a 10-year-old.', 'What is 17 × 23? Show your steps.', 'Write a Python function that reverses a linked list.'].map((q) => button(q, { size: 'sm', kind: 'ghost', onClick: () => ((prompt.value = q), prompt.focus()) })), h('span', { class: 'spacer' }), stopBtn, sendBtn)),
  );
  renderTitles();
  return el;
}

/* ---------------- Suites ---------------- */

function suitesTab(ctx) {
  const { arts, models, d } = ctx;
  const el = h('div', { class: 'col gap-3' });
  const host = h('div', { class: 'col gap-3' });
  const resultHost = h('div');
  let suites = [];
  let selectedSuite = null;
  const selected = new Set(arts.filter((a) => a.exists).slice(0, 2).map((a) => a.id));

  const renderResult = (job) => {
    const r = job.result;
    if (!r?.rows) return;
    clear(resultHost).appendChild(
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, icon('list-checks', 'sm'), `Results · ${r.suite}`),
        h(
          'div',
          { class: 'card-body grid-3' },
          r.summary.map((s) =>
            h(
              'div',
              { class: 'card stat' },
              h('div', { class: 'label' }, `${s.format.toUpperCase()} ${s.variant}`),
              h('div', { class: 'value' }, s.exact != null ? pct(s.exact, 0) : '—'),
              h('div', { class: 'delta' }, 'correct ', infoIcon('eval.exact_match'), ` · ROUGE-L ${s.rouge_l != null ? fixed(s.rouge_l, 2) : '—'} `, infoIcon('eval.rouge_l'), ` · ${fixed(s.tok_s, 0)} tok/s`, s.agreement != null ? ` · agreement with A ${pct(s.agreement, 0)}` : ''),
            ),
          ),
        ),
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Prompt'), ...r.summary.map((s) => h('th', null, `${s.variant}`)), h('th', { class: 'num' }, 'Agreement'))),
          h(
            'tbody',
            null,
            r.rows.map((row) =>
              h(
                'tr',
                null,
                h('td', { style: { maxWidth: '260px' } }, h('div', { class: 'small' }, (row.prompt || '').replace('{{haystack}}', '[long passage]').slice(0, 220)), row.reference ? h('div', { class: 'xs muted' }, `Expected: ${row.reference}`) : null),
                ...row.results.map((res) => h('td', { style: { maxWidth: '320px' } }, res.exact != null ? badge(res.exact ? 'correct' : 'wrong', res.exact ? 'success' : 'danger') : null, h('div', { class: 'small selectable', style: { whiteSpace: 'pre-wrap', maxHeight: '160px', overflow: 'auto' } }, res.output))),
                h('td', { class: 'num' }, row.agreement != null ? pct(row.agreement, 0) : '—'),
              ),
            ),
          ),
        ),
      ),
    );
  };

  const render = () => {
    clear(host);
    host.append(
      h(
        'div',
        { class: 'grid-3' },
        suites.map((s) =>
          h(
            'div',
            { class: `opt-card compact ${selectedSuite === s.id ? 'selected' : ''}`, onClick: () => ((selectedSuite = s.id), render()) },
            h('div', { class: 'title' }, s.name, s.builtin ? null : badge('custom', 'outline'), h('span', { class: 'tick' }, icon('circle-check', 'sm'))),
            h('div', { class: 'desc' }, s.description || ''),
            h('div', { class: 'xs muted' }, `${s.prompts.length} prompts`),
          ),
        ),
      ),
      h(
        'div',
        { class: 'card pad col gap-2' },
        h('div', { class: 'row' }, h('b', null, 'Models to test'), h('span', { class: 'small muted' }, 'Pick two to see how often they agree.')),
        h('div', { class: 'grid-2' }, arts.filter((a) => a.exists).map((a) => checkbox({ label: artLabel(a, models), info: a.role === 'reference' ? 'eval.reference' : `format.${a.format}`, checked: selected.has(a.id), onChange: (v) => (v ? selected.add(a.id) : selected.delete(a.id)) }))),
      ),
      h(
        'div',
        { class: 'row' },
        button('New custom suite', { iconName: 'plus', onClick: newSuite }),
        h('span', { class: 'spacer' }),
        button('Run suite', {
          kind: 'primary',
          iconName: 'play',
          onClick: async () => {
            if (!selectedSuite) return toast('Pick a suite first', { kind: 'warning' });
            try {
              const id = await call('suite_run', { suiteId: selectedSuite, artifactIds: [...selected], paramsJson: { temperature: 0, max_tokens: 256, seed: 42 } });
              const job = await call('job_get', { id });
              const card = jobCard(job, {
                onDone: async (j) => {
                  if (j.status === 'done') renderResult(await call('job_get', { id }));
                },
              });
              d(card.dispose);
              clear(resultHost).appendChild(card);
            } catch (e) {
              showError(e);
            }
          },
        }),
      ),
    );
  };

  function newSuite() {
    const name = h('input', { class: 'input', placeholder: 'Suite name' });
    const text = h('textarea', { class: 'textarea mono', rows: 8, placeholder: 'One prompt per line. Optionally add the expected answer after "||"\nWhat is the capital of Japan? || Tokyo' });
    openModal({
      title: 'New prompt suite',
      body: h('div', { class: 'col gap-3' }, name, text, h('div', { class: 'small muted' }, 'Use prompts that look like your real use. Expected answers enable "correct" scoring.')),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save',
          kind: 'primary',
          onClick: async () => {
            const prompts = text.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const [p, r] = l.split('||').map((x) => x.trim());
                return { prompt: p, reference: r || null };
              });
            try {
              await call('suite_save', { name: name.value, prompts });
              suites = await call('suites_list');
              render();
            } catch (e) {
              showError(e);
              return false;
            }
          },
        },
      ],
    });
  }

  call('suites_list')
    .then((s) => {
      suites = s;
      selectedSuite = s[0]?.id;
      render();
    })
    .catch(showError);
  el.append(h('div', { class: 'small muted' }, 'Run the same prompts through each model at temperature 0 and score the answers.'), host, resultHost);
  return el;
}

/* ---------------- Dashboard ---------------- */

function dashboard(ctx) {
  const { arts, models, d } = ctx;
  const el = h('div', { class: 'col gap-3' });
  const modelIds = [...new Set(arts.map((a) => a.model_id))];
  let modelId = ctx.query.model && modelIds.includes(ctx.query.model) ? ctx.query.model : modelIds[0];
  const jobsHost = h('div', { class: 'col gap-2' });
  const body = h('div', { class: 'col gap-3' });
  const selected = new Set();

  const render = () => {
    clear(body);
    const mine = arts.filter((a) => a.model_id === modelId);
    if (!mine.length) {
      body.appendChild(h('div', { class: 'card' }, empty({ iconName: 'chart-scatter', title: 'No results yet', text: 'Quantize a model with evaluation turned on, or measure existing outputs below.' })));
      return;
    }
    const pts = mine
      .filter((a) => a.role !== 'reference' && a.metrics.kld_mean != null)
      .map((a) => ({ x: (a.size_bytes || 0) / 1e6, y: Math.max(a.metrics.kld_mean, 1e-4), label: a.variant, color: FORMAT_COLOR[a.format], format: a.format, group: a.format }));
    for (const f of ['gguf', 'mlx', 'onnx']) paretoFrontier(pts.filter((p) => p.format === f));
    body.append(
      pts.length
        ? h(
            'div',
            { class: 'card pad col gap-2' },
            h('div', { class: 'row' }, h('b', null, 'Size vs. quality'), infoIcon('eval.pareto'), h('span', { class: 'small muted' }, 'Lower-left is better: smaller files that stay closer to the original. Dashed line = best trade-offs per format.')),
            scatter(pts, { xLabel: 'file size (MB)', yLabel: 'KL divergence (log)', logY: true }),
            legend(Object.entries(FORMAT_COLOR).map(([f, c]) => ({ color: c, label: f.toUpperCase() }))),
          )
        : callout('info', 'info', 'Measure quality to see the size-vs-quality chart.'),
      h(
        'div',
        { class: 'card' },
        h(
          'table',
          { class: 'table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, ''),
              h('th', null, 'Output'),
              h('th', { class: 'num' }, 'Size'),
              h('th', { class: 'num' }, h('span', null, 'bpw ', infoIcon('concept.bpw'))),
              h('th', { class: 'num' }, h('span', null, 'PPL ', infoIcon('eval.ppl'))),
              h('th', { class: 'num' }, h('span', null, 'KLD ', infoIcon('eval.kld'))),
              h('th', { class: 'num' }, h('span', null, 'Top-1 ', infoIcon('eval.top1'))),
              h('th', { class: 'num' }, h('span', null, 'Prompt tok/s ', infoIcon('eval.speed_pp'))),
              h('th', { class: 'num' }, h('span', null, 'Gen tok/s ', infoIcon('eval.speed_tg'))),
              h('th', { class: 'num' }, h('span', null, 'Suite ', infoIcon('eval.exact_match'))),
            ),
          ),
          h(
            'tbody',
            null,
            mine.map((a) => {
              const m = a.metrics;
              return h(
                'tr',
                null,
                h('td', null, checkbox({ label: '', checked: selected.has(a.id), onChange: (v) => (v ? selected.add(a.id) : selected.delete(a.id)) })),
                h('td', null, badge(a.format.toUpperCase(), 'outline'), ' ', h('span', { class: 'mono' }, a.variant), a.role === 'reference' ? ' ' : null, a.role === 'reference' ? badge('original', 'info') : null),
                h('td', { class: 'num' }, bytes(a.size_bytes)),
                h('td', { class: 'num' }, a.bpw ? a.bpw.toFixed(2) : '—'),
                h('td', { class: 'num' }, m.ppl != null ? fixed(m.ppl, 3) : '—'),
                h('td', { class: 'num' }, m.kld_mean != null ? fixed(m.kld_mean, 4) : '—'),
                h('td', { class: 'num' }, m.top1 != null ? pct(m.top1, 1) : '—'),
                h('td', { class: 'num' }, m.pp_tok_s != null ? fixed(m.pp_tok_s, 0) : '—'),
                h('td', { class: 'num' }, m.tg_tok_s != null ? fixed(m.tg_tok_s, 1) : '—'),
                h('td', { class: 'num' }, m.suite_exact != null ? pct(m.suite_exact, 0) : '—'),
              );
            }),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        button('Measure speed of selected', {
          iconName: 'timer',
          onClick: () => startJob('eval_speed', { artifactIds: [...selected] }),
        }),
        button('Measure quality vs original', {
          iconName: 'scale',
          onClick: () => {
            const chosen = mine.filter((a) => selected.has(a.id));
            const ref = mine.find((a) => a.role === 'reference' && chosen[0] && a.format === chosen[0].format);
            if (!chosen.length || !ref) return toast('Select quantized outputs of one format', { kind: 'warning', detail: 'Quality is measured against the original in the same runtime.' });
            startJob('eval_quality', { artifactIds: chosen.map((a) => a.id), referenceId: ref.id, chunks: 40 });
          },
        }),
        infoIcon('eval.reference'),
      ),
    );
  };

  async function startJob(cmd, args) {
    if (!args.artifactIds.length) return toast('Select at least one output', { kind: 'warning' });
    try {
      const id = await call(cmd, args);
      const job = await call('job_get', { id });
      const card = jobCard(job, {
        onDone: async () => {
          ctx.arts = await call('artifacts_list', {});
          arts.splice(0, arts.length, ...ctx.arts);
          render();
        },
      });
      d(card.dispose);
      jobsHost.prepend(card);
    } catch (e) {
      showError(e);
    }
  }

  el.append(
    modelIds.length > 1 ? segmented({ value: modelId, options: modelIds.map((id) => ({ value: id, label: models.find((m) => m.id === id)?.name || id })), onChange: (v) => ((modelId = v), render()) }) : null,
    jobsHost,
    body,
  );
  render();
  return el;
}

export default async function testView(root, { query }) {
  setCrumbs([]);
  const d = disposer();
  const view = h('div', { class: 'view wide' });
  root.appendChild(view);
  const [arts, models] = await Promise.all([call('artifacts_list', {}).catch(() => []), call('models_list').catch(() => [])]);
  const ctx = { arts, models, query, d };
  const tabs = ['Arena', 'Prompt suites', 'Quality & speed'];
  if (query.tab && tabs.includes(query.tab)) lastTab = query.tab;
  const host = h('div');
  const tabBar = h('div', { class: 'tabs' });
  const renderTab = () => {
    clear(tabBar).append(...tabs.map((t) => h('button', { class: t === lastTab ? 'on' : '', onClick: () => ((lastTab = t), renderTab()) }, t)));
    clear(host).appendChild({ Arena: arena, 'Prompt suites': suitesTab, 'Quality & speed': dashboard }[lastTab](ctx));
  };
  view.append(
    h(
      'div',
      { class: 'view-head' },
      h('div', null, h('h1', null, 'Test & Compare'), h('div', { class: 'sub' }, 'Put a quantized model next to its original: chat side by side, run prompt suites, and measure quality and speed.')),
      h('div', { class: 'actions' }, button('Stop all models', { kind: 'ghost', iconName: 'circle-stop', onClick: () => call('runner_stop', {}).then(() => toast('Inference servers stopped', { kind: 'success' })) })),
    ),
    tabBar,
    host,
  );
  renderTab();
  return () => d.dispose();
}

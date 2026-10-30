// Live job view: pipeline, the tensor X-ray filling as quantization sweeps the model,
// shrinking-size meter, bit-width histogram, metric chart, system gauges, logs and results.

import { badge, button, callout } from '../components/controls.js';
import { infoIcon } from '../components/info.js';
import { logConsole, statusBadge, watchJob } from '../components/jobs.js';
import { confirm, showError } from '../components/overlay.js';
import { bitsFromDtype, tensorMap } from '../components/tensor-map.js';
import { legend, lineChart, sparkline } from '../lib/charts.js';
import { clear, h, icon } from '../lib/dom.js';
import { bytes, bitsColorVar, duration, fixed, pct } from '../lib/format.js';
import { call, disposer } from '../lib/ipc.js';
import { go, setCrumbs } from '../lib/router.js';

const STAGE_ICON = { done: 'circle-check', running: 'loader-circle', failed: 'circle-x', cancelled: 'circle-stop', skipped: 'circle-dot', pending: 'circle' };

function pipeline(stages) {
  const el = h('div', { class: 'pipeline' });
  stages.forEach((s, i) => {
    if (i) el.appendChild(h('div', { class: `pipe-link ${s.status === 'done' || s.status === 'running' ? (stages[i - 1].status === 'done' && s.status === 'running' ? 'running' : 'done') : ''}` }));
    const det = s.cached ? 'Reused from cache' : s.started_at && s.finished_at ? duration(s.finished_at - s.started_at) : s.status === 'running' ? 'In progress' : s.status === 'skipped' ? 'Skipped' : '';
    el.appendChild(h('div', { class: `pipe-node ${s.status}` }, h('div', { class: 'lbl' }, icon(STAGE_ICON[s.status] || 'circle', 'sm'), s.label), h('div', { class: 'det' }, det), s.cached ? badge('cached', 'outline') : null));
  });
  return el;
}

function histogramBar(hist) {
  const total = hist.reduce((a, b) => a + b.params, 0) || 1;
  return h(
    'div',
    { class: 'col gap-2' },
    h('div', { class: 'hist-bar' }, hist.map((e) => h('i', { title: `${e.label}: ${pct(e.params / total, 1)}`, style: { width: `${(e.params / total) * 100}%`, background: bitsColorVar(e.bits) } }))),
    legend(hist.slice(0, 8).map((e) => ({ color: bitsColorVar(e.bits), label: `${e.label} ${pct(e.params / total, 0)}` }))),
  );
}

export default async function jobDetail(root, { params }) {
  const d = disposer();
  const view = h('div', { class: 'view wide' });
  root.appendChild(view);
  let job;
  try {
    job = await call('job_get', { id: params.id });
  } catch (e) {
    view.appendChild(callout('danger', 'circle-x', e.message));
    return;
  }
  setCrumbs([job.title]);
  const isQuant = job.kind === 'quantize';
  let tensors = [];
  if (job.model_id && isQuant) tensors = await call('model_tensors', { id: job.model_id }).catch(() => []);

  const head = h('div', { class: 'view-head' });
  const pipeHost = h('div', { class: 'card pad', style: { marginBottom: '16px' } });
  const mapHost = h('div');
  const mapTitle = h('span', { class: 'muted small' });
  const statsHost = h('div', { class: 'col gap-3' });
  const sizeNow = h('span', { class: 'now' }, '—');
  const sizeFrom = h('span', { class: 'from' });
  const ratioEl = h('div', { class: 'small muted' });
  const countEl = h('div', { class: 'small muted' });
  const etaEl = h('div', { class: 'small muted' });
  const detailEl = h('div', { class: 'small ellipsis', style: { color: 'var(--text-2)' } });
  const histHost = h('div');
  const chartHost = h('div', { class: 'hidden card pad col gap-2' });
  const chartTitle = h('div', { class: 'row' }, h('b', null, 'Perplexity per chunk'), infoIcon('eval.ppl'));
  const sysHost = h('div', { class: 'col gap-2' });
  const resultsHost = h('div');
  const log = logConsole(job.id, { height: 300 });
  d(log.dispose);

  let map = null;
  const resetMap = (label) => {
    map?.dispose();
    map = tensors.length ? tensorMap(tensors, { height: 230 }) : null;
    clear(mapHost).appendChild(map ? map.el : h('div', { class: 'muted small' }, 'Tensor layout unavailable for this job.'));
    mapTitle.textContent = label ? `Now: ${label}` : '';
    clear(histHost);
    updateStats();
  };

  function updateStats(extra) {
    if (!map) return;
    const s = map.stats();
    const remaining = s.srcBytes - (s.outParams ? s.srcBytes * (s.outParams / s.params) : 0);
    const ratio = s.outParams ? s.outBytes / (s.srcBytes * (s.outParams / s.params)) : null;
    const projected = ratio != null ? s.outBytes + remaining * ratio : null;
    sizeFrom.textContent = bytes(s.srcBytes);
    sizeNow.textContent = projected != null ? bytes(projected) : bytes(s.srcBytes);
    ratioEl.textContent = ratio != null ? `${(1 / ratio).toFixed(2)}× smaller · ${fixed((s.outBytes * 8) / Math.max(1, s.outParams), 2)} bits per weight so far` : 'Waiting for the first tensor…';
    countEl.textContent = `${s.done} of ${s.total} tensors quantized`;
    if (extra?.eta_s) etaEl.textContent = `About ${duration(extra.eta_s * 1000)} left in this step`;
    const hist = map.histogram();
    if (hist.length) clear(histHost).appendChild(histogramBar(hist));
  }

  const metricPoints = new Map();
  function onMetrics(items) {
    for (const it of items) {
      if (!metricPoints.has(it.name)) metricPoints.set(it.name, []);
      metricPoints.get(it.name).push({ x: it.step ?? metricPoints.get(it.name).length + 1, y: it.value });
    }
    chartHost.classList.remove('hidden');
    const series = [...metricPoints.entries()].slice(-1).map(([name, pts]) => ({ name, points: pts, color: 'var(--series-1)' }));
    chartTitle.firstChild.textContent = metricPoints.has('imatrix_ppl') && series[0]?.name === 'imatrix_ppl' ? 'Calibration perplexity per chunk (importance matrix)' : 'Perplexity per chunk';
    clear(chartHost).append(chartTitle, lineChart({ series, height: 160, xLabel: 'chunk', yLabel: 'PPL' }));
  }

  function onTensors(items) {
    for (const it of items) {
      if (it.t === 'reset') resetMap(it.variant);
      else if (!map) continue;
      else if (it.t === 'tensor') map.markDone(it.name, { to: it.to || it.dtype, bits: it.bits ?? bitsFromDtype(it.to), bytes_out: it.bytes_out });
      else if (it.t === 'convert') map.markActive(it.name);
      else if (it.t === 'block') {
        if (it.block === 'embed' || it.block === 'head') map.markBlock(it.block, it.bits, it.to);
        else map.markBlock(Number(it.block), it.bits, it.to);
      }
    }
    updateStats();
  }

  function renderHead() {
    const live = ['running', 'queued'].includes(job.status);
    clear(head).append(
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'row' }, h('h1', { class: 'ellipsis' }, job.title), statusBadge(job.status)),
        h('div', { class: 'sub' }, job.model_id ? h('a', { onClick: () => go(`/models/${job.model_id}`) }, 'Open model →') : null, job.started_at ? `  · started ${new Date(job.started_at).toLocaleTimeString()}` : '', job.finished_at ? ` · took ${duration(job.finished_at - job.started_at)}` : ''),
      ),
      h(
        'div',
        { class: 'actions' },
        live ? button('Cancel', { iconName: 'circle-stop', onClick: () => call('job_cancel', { id: job.id }).catch(showError) }) : null,
        !live
          ? button('', {
              kind: 'ghost',
              iconName: 'trash-2',
              title: 'Delete job record',
              onClick: async () => {
                if (await confirm({ title: 'Delete this job record?', text: 'Outputs on disk are kept.', confirmLabel: 'Delete', danger: true })) {
                  await call('job_delete', { id: job.id }).catch(showError);
                  go('/jobs');
                }
              },
            })
          : null,
      ),
    );
    clear(pipeHost).appendChild(pipeline(job.stages));
    if (job.status === 'failed' && job.error) pipeHost.appendChild(h('div', { style: { marginTop: '12px' } }, callout('danger', 'circle-x', h('div', { class: 'selectable', style: { whiteSpace: 'pre-wrap' } }, job.error))));
  }

  async function renderResults() {
    if (!isQuant || !job.model_id || job.status !== 'done') return;
    const all = await call('artifacts_list', { modelId: job.model_id }).catch(() => []);
    const mine = all.filter((a) => a.job_id === job.id);
    if (!mine.length) return;
    const refs = mine.filter((a) => a.role === 'reference');
    const quants = mine.filter((a) => a.role !== 'reference');
    const ref = refs[0];
    const variantSel = h('div', { class: 'row wrap gap-1' });
    const showVariant = async (a) => {
      const ts = await call('artifact_tensors', { id: a.id }).catch(() => []);
      resetMap(`${a.variant} (final)`);
      if (map && ts.length) {
        for (const t of ts) map.markDone(t.name, { to: t.dtype, bits: t.bits, bytes_out: t.bytes });
        map.finish();
        updateStats();
        sizeNow.textContent = bytes(a.size_bytes);
      }
      variantSel.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === a.id));
    };
    variantSel.append(...quants.map((a) => h('button', { class: 'btn sm', data: { id: a.id }, onClick: () => showVariant(a) }, a.variant)));
    clear(resultsHost).appendChild(
      h(
        'div',
        { class: 'card', style: { marginTop: '16px' } },
        h('div', { class: 'card-head' }, icon('list-checks', 'sm'), 'Results', h('div', { class: 'actions' }, button('Compare & test', { size: 'sm', iconName: 'flask-conical', onClick: () => go(`/test?a=${quants[0]?.id || ''}&b=${ref?.id || ''}`) }), button('Write model card', { size: 'sm', kind: 'primary', iconName: 'file-text', onClick: () => go(`/docs?job=${job.id}`) }))),
        h(
          'table',
          { class: 'table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, 'Variant'),
              h('th', { class: 'num' }, 'Size'),
              h('th', { class: 'num' }, h('span', null, 'Bits/weight ', infoIcon('concept.bpw'))),
              h('th', { class: 'num' }, h('span', null, 'Perplexity ', infoIcon('eval.ppl'))),
              h('th', { class: 'num' }, h('span', null, 'KL divergence ', infoIcon('eval.kld'))),
              h('th', { class: 'num' }, h('span', null, 'Same top token ', infoIcon('eval.top1'))),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            [...refs, ...quants].map((a) =>
              h(
                'tr',
                null,
                h('td', null, h('span', { class: 'mono' }, a.variant), ' ', a.role === 'reference' ? badge('reference', 'info') : null),
                h('td', { class: 'num' }, bytes(a.size_bytes)),
                h('td', { class: 'num' }, a.bpw ? a.bpw.toFixed(2) : '—'),
                h('td', { class: 'num' }, a.metrics.ppl ? fixed(a.metrics.ppl, 3) : '—', a.metrics.ppl_base && a.role !== 'reference' ? h('span', { class: 'muted' }, ` (+${fixed(((a.metrics.ppl - a.metrics.ppl_base) / a.metrics.ppl_base) * 100, 1)}%)`) : null),
                h('td', { class: 'num' }, a.metrics.kld_mean != null ? fixed(a.metrics.kld_mean, 4) : '—'),
                h('td', { class: 'num' }, a.metrics.top1 != null ? pct(a.metrics.top1, 1) : '—'),
                h('td', null, h('div', { class: 'row' }, button('', { size: 'sm', kind: 'ghost', iconName: 'folder-open', title: 'Reveal', onClick: () => call('reveal_path', { path: a.path }).catch(showError) }), a.role !== 'reference' ? button('Test', { size: 'sm', onClick: () => go(`/test?a=${a.id}&b=${ref?.id || ''}`) }) : null)),
              ),
            ),
          ),
        ),
        quants.length && tensors.length ? h('div', { class: 'card-body row' }, h('span', { class: 'small muted' }, 'Show the final tensor map for:'), variantSel) : null,
      ),
    );
    if (quants[0] && tensors.length) showVariant(quants[0]);
  }

  // System gauges while running.
  const cpu = [];
  const mem = [];
  async function pollSys() {
    try {
      const s = await call('system_stats');
      cpu.push(s.cpu);
      mem.push(s.children_rss);
      if (cpu.length > 60) cpu.shift(), mem.shift();
      clear(sysHost).append(
        h('div', { class: 'row between small' }, h('span', { class: 'muted' }, 'CPU'), h('b', null, `${s.cpu.toFixed(0)}%`)),
        sparkline(cpu, { max: 100 }),
        h('div', { class: 'row between small' }, h('span', { class: 'muted' }, 'Tool memory'), h('b', null, bytes(s.children_rss))),
        sparkline(mem, { color: 'var(--series-2)' }),
        h('div', { class: 'row between small' }, h('span', { class: 'muted' }, 'System RAM'), h('span', null, `${bytes(s.ram_used)} / ${bytes(s.ram_total)}`)),
        h('div', { class: 'row between small' }, h('span', { class: 'muted' }, 'Free disk'), h('span', null, bytes(s.disk_free))),
      );
    } catch {
      /* ignore */
    }
  }

  renderHead();
  resetMap(null);
  view.append(
    head,
    pipeHost,
    h(
      'div',
      { class: 'grid-3', style: { gridTemplateColumns: '2fr 1fr', alignItems: 'start' } },
      h(
        'div',
        { class: 'col gap-3' },
        isQuant ? h('div', { class: 'card pad col gap-3' }, h('div', { class: 'row' }, h('b', null, 'Model X-ray'), infoIcon('concept.quantization'), mapTitle), detailEl, mapHost) : null,
        chartHost,
        h('div', { class: 'card pad col gap-2' }, h('div', { class: 'row' }, h('b', null, 'Log'), h('span', { class: 'spacer' }), button('Copy', { size: 'sm', kind: 'ghost', iconName: 'copy', onClick: () => navigator.clipboard?.writeText(log.copyText()) })), log),
      ),
      h(
        'div',
        { class: 'col gap-3' },
        isQuant
          ? h(
              'div',
              { class: 'card pad col gap-2' },
              h('div', { class: 'row' }, h('b', null, 'Size'), infoIcon('concept.bpw')),
              h('div', { class: 'size-meter' }, sizeNow, sizeFrom),
              ratioEl,
              countEl,
              etaEl,
              h('div', { class: 'row', style: { marginTop: '6px' } }, h('b', null, 'Precision mix'), infoIcon('concept.mixed_precision')),
              histHost,
            )
          : null,
        h('div', { class: 'card pad col gap-2' }, h('b', null, 'System'), sysHost),
        statsHost,
      ),
    ),
    resultsHost,
  );

  // Catch up on tensor events emitted before this view opened.
  if (['running', 'queued'].includes(job.status)) {
    const history = await call('job_tensor_events', { id: job.id }).catch(() => []);
    if (history.length) onTensors(history);
    pollSys();
    const t = setInterval(pollSys, 1500);
    d(() => clearInterval(t));
  } else {
    pollSys();
  }
  d(
    watchJob(job.id, {
      onUpdate: (j) => {
        const finished = job.status !== j.status && j.status === 'done';
        job = j;
        renderHead();
        if (finished) renderResults();
      },
      onProgress: (p) => {
        if (p.detail) detailEl.textContent = p.detail;
        if (p.extra) updateStats(p.extra);
      },
      onTensor: onTensors,
      onMetric: onMetrics,
    }),
  );
  await renderResults();
  return () => {
    d.dispose();
    map?.dispose();
  };
}

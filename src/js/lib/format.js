// Number, size and time formatting.

export function bytes(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const d = i === 0 ? 0 : v >= 100 ? 0 : digits;
  return `${n < 0 ? '-' : ''}${v.toFixed(d)} ${units[i]}`;
}

export function num(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Short counts for badges: 1234 → 1.2K, 3400000 → 3.4M. */
export function compact(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function fixed(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toFixed(digits);
}

export function params(n) {
  if (!n) return '—';
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  return `${(n / 1e3).toFixed(0)}K`;
}

export function pct(f, digits = 0) {
  if (f == null || Number.isNaN(f)) return '—';
  return `${(f * 100).toFixed(digits)}%`;
}

export function duration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ago(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 45_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function datetime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function plural(n, word, pl) {
  return `${n} ${n === 1 ? word : pl || `${word}s`}`;
}

/** Maps a bit width to the CSS variable used by the tensor map / histograms. */
export function bitsColorVar(bits) {
  if (bits == null) return 'var(--cell-empty)';
  if (bits <= 1.6) return 'var(--bits-1)';
  if (bits <= 2.7) return 'var(--bits-2)';
  if (bits <= 3.7) return 'var(--bits-3)';
  if (bits <= 4.7) return 'var(--bits-4)';
  if (bits <= 5.7) return 'var(--bits-5)';
  if (bits <= 7) return 'var(--bits-6)';
  if (bits <= 9) return 'var(--bits-8)';
  if (bits <= 17) return 'var(--bits-16)';
  return 'var(--bits-32)';
}

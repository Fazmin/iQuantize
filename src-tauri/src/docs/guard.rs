//! Flags numbers in AI-written text that cannot be traced to the provenance data or the
//! deterministic template, so invented figures are easy to spot before publishing.

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;

static NUM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[^\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(%|[KMGT]B|B\b)?").unwrap()
});

#[derive(Debug, Clone, Serialize)]
pub struct Flag {
    pub value: String,
    pub context: String,
    pub start: usize,
}

/// Fields whose digits are identifiers, not facts worth citing.
const SKIP_KEYS: &[&str] = &[
    "sha256",
    "id",
    "revision",
    "generated_at",
    "commit",
    "job_id",
];

fn collect(v: &Value, out: &mut Vec<f64>) {
    match v {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                out.push(f);
            }
        }
        Value::String(s) => {
            for c in NUM.captures_iter(s) {
                if let Ok(f) = c[1].replace(',', "").parse::<f64>() {
                    out.push(f);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect(x, out)),
        Value::Object(o) => o
            .iter()
            .filter(|(k, _)| !SKIP_KEYS.contains(&k.as_str()))
            .for_each(|(_, x)| collect(x, out)),
        _ => {}
    }
}

fn round_to(v: f64, decimals: usize) -> f64 {
    let p = 10f64.powi(decimals as i32);
    (v * p).round() / p
}

/// A written number matches a known value if that value, shown at the same precision
/// (optionally as a percentage or in K/M/G units), reads the same.
fn matches(raw: &str, candidate: f64, known: &[f64]) -> bool {
    let decimals = raw.split('.').nth(1).map(|d| d.len()).unwrap_or(0);
    known.iter().any(|&k| {
        [k, k * 100.0, k / 1e3, k / 1e6, k / 1e9].iter().any(|&v| {
            let r = round_to(v, decimals);
            (r - candidate).abs() < 1e-9 || (decimals == 0 && (v.trunc() - candidate).abs() < 1e-9)
        })
    })
}

/// Returns numbers in `text` not found in `provenance` or in `template`.
pub fn check(text: &str, provenance: &Value, template: &str) -> Vec<Flag> {
    let mut known = vec![];
    collect(provenance, &mut known);
    collect(&Value::String(template.to_string()), &mut known);
    let mut seen = HashSet::new();
    let mut flags = vec![];
    let in_code = code_ranges(text);
    for c in NUM.captures_iter(text) {
        let m = c.get(1).unwrap();
        if in_code.iter().any(|r| r.contains(&m.start())) {
            continue;
        }
        let raw = m.as_str().replace(',', "");
        let Ok(val) = raw.parse::<f64>() else {
            continue;
        };
        // Small integers are usually list numbers, counts in prose or step labels.
        if !raw.contains('.') && val <= 12.0 {
            continue;
        }
        // Years and well-known constants are fine.
        if !raw.contains('.') && (1990.0..=2100.0).contains(&val) {
            continue;
        }
        if matches(&raw, val, &known) {
            continue;
        }
        if seen.insert(raw.clone()) {
            let start = m.start();
            let lo = text[..start]
                .char_indices()
                .rev()
                .nth(40)
                .map(|(i, _)| i)
                .unwrap_or(0);
            let hi = text[start..]
                .char_indices()
                .nth(40)
                .map(|(i, _)| start + i)
                .unwrap_or(text.len());
            flags.push(Flag {
                value: format!(
                    "{}{}",
                    m.as_str(),
                    c.get(2).map(|u| u.as_str()).unwrap_or("")
                ),
                context: text[lo..hi].replace('\n', " "),
                start,
            });
        }
    }
    flags
}

fn code_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut out = vec![];
    let mut pos = 0;
    while let Some(i) = text[pos..].find("```") {
        let start = pos + i;
        match text[start + 3..].find("```") {
            Some(j) => {
                out.push(start..start + 3 + j + 3);
                pos = start + 3 + j + 3;
            }
            None => {
                out.push(start..text.len());
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flags_invented_numbers_only() {
        let prov = json!({ "outputs": [{ "metrics": { "ppl": 21.424, "kld_mean": 0.0369, "top1": 0.882 }, "size_bytes": 105_500_000 }] });
        let text = "Q4_K_M has perplexity 21.42 (KLD 0.037) and keeps 88.2% of top tokens. It is 105.5 MB. It scores 73.4 on MMLU and 21.9 on X. Step 3 is easy. Released in 2026.\n```bash\nllama-cli -n 999\n```";
        let flags = check(text, &prov, "");
        let vals: Vec<&str> = flags.iter().map(|f| f.value.as_str()).collect();
        assert_eq!(vals, vec!["73.4", "21.9"], "{flags:?}");
        // Digits inside hashes never vouch for invented numbers.
        let prov2 = json!({ "outputs": [{ "sha256": "71.3", "metrics": { "top1": 0.882 } }] });
        assert_eq!(check("keeps 88.2% and scores 71.3", &prov2, "").len(), 1);
    }
}

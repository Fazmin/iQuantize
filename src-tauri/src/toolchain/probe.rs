//! Capability probes: parse each installed tool's `--help` so the UI only offers options the
//! exact installed version supports.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QuantTypeCap {
    pub name: String,
    pub id: Option<u32>,
    pub description: String,
    /// Bits per weight when the help states it directly ("2.06 bpw").
    pub bpw: Option<f64>,
    /// Size of Llama-3-8B (GiB) when stated ("4.58G").
    pub size_gib_8b: Option<f64>,
    /// Perplexity increase on Llama-3-8B when stated ("+0.1754 ppl").
    pub ppl_delta: Option<f64>,
    pub alias_of: Option<String>,
}

static TYPE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:(\d+)\s+or\s+)?([A-Z][A-Z0-9_]*)\s*:\s*(.+?)\s*$").unwrap()
});
static BPW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([0-9.]+)\s*bpw").unwrap());
static SIZE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9.]+)G").unwrap());
static PPL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([+-][0-9.]+)\s*ppl").unwrap());
static ALIAS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"alias for ([A-Z0-9_]+)").unwrap());
static FLAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)(?:^\s*|\[|,\s*)(--[a-z][a-z0-9-]*)").unwrap());

/// Parses the "allowed quantization types" section of `llama-quantize --help`.
pub fn parse_quant_types(help: &str) -> Vec<QuantTypeCap> {
    let mut out = vec![];
    let mut in_section = false;
    for line in help.lines() {
        if line.contains("allowed quantization types") {
            in_section = true;
            continue;
        }
        if !in_section || line.trim().is_empty() || line.trim_start().starts_with('-') {
            continue;
        }
        let Some(c) = TYPE_LINE.captures(line) else {
            continue;
        };
        let desc = c[3].to_string();
        out.push(QuantTypeCap {
            name: c[2].to_string(),
            id: c.get(1).and_then(|m| m.as_str().parse().ok()),
            bpw: BPW.captures(&desc).and_then(|m| m[1].parse().ok()),
            size_gib_8b: SIZE.captures(&desc).and_then(|m| m[1].parse().ok()),
            ppl_delta: PPL.captures(&desc).and_then(|m| m[1].parse().ok()),
            alias_of: ALIAS.captures(&desc).map(|m| m[1].to_string()),
            description: desc,
        });
    }
    out
}

/// Collects `--long-flags` mentioned in a help text (deduplicated, in order).
pub fn parse_flags(help: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = vec![];
    for c in FLAG.captures_iter(help) {
        let f = c[1].to_string();
        if seen.insert(f.clone()) {
            out.push(f);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELP: &str = include_str!("../../tests/fixtures/llama-quantize-help.txt");

    #[test]
    fn parses_real_llama_quantize_help() {
        let types = parse_quant_types(HELP);
        let q4km = types.iter().find(|t| t.name == "Q4_K_M").expect("Q4_K_M");
        assert_eq!(q4km.size_gib_8b, Some(4.58));
        assert_eq!(q4km.ppl_delta, Some(0.1754));
        let iq2 = types.iter().find(|t| t.name == "IQ2_XXS").unwrap();
        assert_eq!(iq2.bpw, Some(2.06));
        let alias = types.iter().find(|t| t.name == "Q4_K").unwrap();
        assert_eq!(alias.alias_of.as_deref(), Some("Q4_K_M"));
        assert!(types.iter().any(|t| t.name == "COPY"));
        assert!(types.iter().any(|t| t.name == "Q1_0"));
        assert!(types.len() >= 38, "got {}", types.len());
    }

    #[test]
    fn parses_flags() {
        let flags = parse_flags(HELP);
        for f in [
            "--imatrix",
            "--tensor-type",
            "--output-tensor-type",
            "--dry-run",
            "--keep-split",
            "--pure",
        ] {
            assert!(flags.contains(&f.to_string()), "missing {f}");
        }
    }
}

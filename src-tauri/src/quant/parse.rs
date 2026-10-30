//! Parsers for llama.cpp tool output (fixture-tested against real runs).

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuantLine {
    pub idx: u64,
    pub total: u64,
    pub name: String,
    pub shape: Vec<u64>,
    pub from: String,
    /// Target type (lowercase as printed) or the source type when the tensor is copied.
    pub to: String,
    pub mib_in: f64,
    pub mib_out: f64,
    pub quantized: bool,
}

static QLINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\[\s*(\d+)/\s*(\d+)\]\s+(\S+)\s+-\s+\[([^\]]*)\],\s+type\s*=\s*(\w+),\s*(?:converting to (\w+) \.\. )?size\s*=\s*([0-9.]+)\s*Mi?B(?:\s*->\s*([0-9.]+)\s*Mi?B)?(?:\s*\((\w+)\))?",
    )
    .unwrap()
});
static TOTALS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(model|quant) size\s*=\s*([0-9.]+)\s*MiB(?:\s*\(([0-9.]+) BPW\))?").unwrap()
});
static FALLBACK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^warning:\s+(\S+)\s+- ncols\s+(\d+) not divisible by (\d+) \(required for type\s+(\w+)\) -> falling back to\s+(\w+)").unwrap()
});
static CONVERT_TENSOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^INFO:hf-to-gguf:([\w.]+),\s+(?:torch\.)?(\w+)\s+-->\s+(\w+), shape = \{([^}]*)\}")
        .unwrap()
});
static TQDM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+)%\|").unwrap());
static KLD_ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(\d+)\s+([0-9.]+)\s+±\s+[0-9.]+\s+(-?[0-9.]+)\s+±").unwrap());
static CHUNK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[(\d+)\]\s*([0-9.]+|nan|inf),?").unwrap());

pub fn quant_line(line: &str) -> Option<QuantLine> {
    let c = QLINE.captures(line.trim_start())?;
    // GGUF prints four dims padded with trailing 1s.
    let mut shape: Vec<u64> = c[4]
        .split(',')
        .filter_map(|x| x.trim().parse().ok())
        .collect();
    while shape.len() > 1 && shape.last() == Some(&1) {
        shape.pop();
    }
    let from = c[5].to_string();
    let target = c
        .get(6)
        .or_else(|| c.get(9))
        .map(|m| m.as_str().to_string());
    let mib_in: f64 = c[7].parse().unwrap_or(0.0);
    let mib_out: f64 = c
        .get(8)
        .and_then(|m| m.as_str().parse().ok())
        .unwrap_or(mib_in);
    Some(QuantLine {
        idx: c[1].parse().unwrap_or(0),
        total: c[2].parse().unwrap_or(0),
        name: c[3].to_string(),
        shape,
        quantized: target.is_some(),
        to: target.unwrap_or_else(|| from.clone()),
        from,
        mib_in,
        mib_out,
    })
}

/// "model size = X MiB (16.00 BPW)" / "quant size = Y MiB (6.17 BPW)"
pub fn totals(line: &str) -> Option<(String, f64, Option<f64>)> {
    let c = TOTALS.captures(line)?;
    Some((
        c[1].to_string(),
        c[2].parse().ok()?,
        c.get(3).and_then(|m| m.as_str().parse().ok()),
    ))
}

/// k-quant fallback warnings: (tensor, ncols, required block, wanted type, fallback type)
pub fn fallback(line: &str) -> Option<(String, u64, u64, String, String)> {
    let c = FALLBACK.captures(line)?;
    Some((
        c[1].to_string(),
        c[2].parse().ok()?,
        c[3].parse().ok()?,
        c[4].to_string(),
        c[5].to_string(),
    ))
}

/// convert_hf_to_gguf tensor lines: (name, source dtype, out type, shape)
pub fn convert_tensor(line: &str) -> Option<(String, String, String, Vec<u64>)> {
    let c = CONVERT_TENSOR.captures(line)?;
    let shape = c[4]
        .split(',')
        .filter_map(|x| x.trim().parse().ok())
        .collect();
    Some((c[1].to_string(), c[2].to_string(), c[3].to_string(), shape))
}

/// tqdm-style "Writing:  41%|" percentage.
pub fn tqdm_percent(line: &str) -> Option<f64> {
    TQDM.captures_iter(line)
        .last()
        .and_then(|c| c[1].parse::<f64>().ok())
        .map(|p| p / 100.0)
}

/// "[1]15.3,[2]14.1," chunk progress from llama-imatrix / llama-perplexity.
pub fn chunks(line: &str) -> Vec<(u64, Option<f64>)> {
    CHUNK
        .captures_iter(line)
        .filter_map(|c| {
            Some((
                c[1].parse().ok()?,
                c[2].parse::<f64>().ok().filter(|v| v.is_finite()),
            ))
        })
        .collect()
}

/// KL-divergence mode prints a table row per chunk: (chunk, running ppl, running ln ratio).
pub fn kld_row(line: &str) -> Option<(u64, f64)> {
    let c = KLD_ROW.captures(line)?;
    Some((c[1].parse().ok()?, c[2].parse().ok()?))
}

/// "computing over 6 chunks" from llama-imatrix.
pub fn total_chunks(line: &str) -> Option<u64> {
    Regex::new(r"computing over (\d+) chunks")
        .ok()?
        .captures(line)
        .and_then(|c| c[1].parse().ok())
}

/// Phases reported by the ONNX Runtime GenAI model builder.
#[derive(Debug, Clone, PartialEq)]
pub enum BuilderEvent {
    Embedding,
    Layer(u64),
    FinalNorm,
    LmHead,
    /// Weight-only quantization progress (0..1)
    Quantizing(f64),
    Saving,
}

pub fn builder_events(line: &str) -> Vec<BuilderEvent> {
    static LAYER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"Reading (?:decoder )?layer (\d+)").unwrap());
    static PROG: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"Progress: \[[# ]*\]\s*([0-9.]+)%").unwrap());
    let mut out = vec![];
    if line.contains("Reading embedding layer") {
        out.push(BuilderEvent::Embedding);
    }
    for c in LAYER.captures_iter(line) {
        if let Ok(n) = c[1].parse() {
            out.push(BuilderEvent::Layer(n));
        }
    }
    if line.contains("Reading final norm") {
        out.push(BuilderEvent::FinalNorm);
    }
    if line.contains("Reading LM head") {
        out.push(BuilderEvent::LmHead);
    }
    if let Some(c) = PROG.captures_iter(line).last() {
        if let Ok(p) = c[1].parse::<f64>() {
            out.push(BuilderEvent::Quantizing(p / 100.0));
        }
    }
    if line.contains("Saving GenAI config") || line.starts_with("Saving ") {
        out.push(BuilderEvent::Saving);
    }
    out
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PerplexityStats {
    pub ppl: Option<f64>,
    pub ppl_err: Option<f64>,
    pub ppl_base: Option<f64>,
    pub ppl_ratio: Option<f64>,
    pub kld_mean: Option<f64>,
    pub kld_median: Option<f64>,
    pub kld_p99: Option<f64>,
    pub kld_max: Option<f64>,
    pub top1: Option<f64>,
    pub delta_p_mean: Option<f64>,
    pub rms_delta_p: Option<f64>,
}

fn grab(text: &str, pat: &str) -> Option<f64> {
    Regex::new(pat)
        .ok()?
        .captures(text)
        .and_then(|c| c[1].parse().ok())
}

/// Parses the summary of `llama-perplexity` (plain or --kl-divergence mode).
pub fn perplexity(text: &str) -> PerplexityStats {
    let mut s = PerplexityStats {
        ppl: grab(text, r"Final estimate: PPL = ([0-9.]+)")
            .or_else(|| grab(text, r"Mean PPL\(Q\)\s*:\s*([0-9.]+)")),
        ppl_err: grab(text, r"Final estimate: PPL = [0-9.]+ \+/- ([0-9.]+)")
            .or_else(|| grab(text, r"Mean PPL\(Q\)\s*:\s*[0-9.]+ ±\s*([0-9.]+)")),
        ppl_base: grab(text, r"Mean PPL\(base\)\s*:\s*([0-9.]+)"),
        ppl_ratio: grab(text, r"Mean PPL\(Q\)/PPL\(base\)\s*:\s*([0-9.]+)"),
        kld_mean: grab(text, r"Mean\s+KLD:\s*([0-9.eE+-]+)"),
        kld_median: grab(text, r"Median\s+KLD:\s*([0-9.eE+-]+)"),
        kld_p99: grab(text, r"99\.0%\s+KLD:\s*([0-9.eE+-]+)"),
        kld_max: grab(text, r"Maximum KLD:\s*([0-9.eE+-]+)"),
        top1: grab(text, r"Same top p:\s*([0-9.]+)").map(|p| p / 100.0),
        delta_p_mean: grab(text, r"Mean\s+Δp:\s*([0-9.eE+-]+)").map(|p| p / 100.0),
        rms_delta_p: grab(text, r"RMS Δp\s*:\s*([0-9.eE+-]+)").map(|p| p / 100.0),
    };
    if s.ppl.is_none() {
        // Fall back to the last running estimate.
        s.ppl = chunks(text).into_iter().filter_map(|(_, v)| v).next_back();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUANT: &str = include_str!("../../tests/fixtures/quantize-output.txt");
    const DRY: &str = include_str!("../../tests/fixtures/quantize-dryrun.txt");
    const CONVERT: &str = include_str!("../../tests/fixtures/convert-output.txt");

    #[test]
    fn parses_real_quantize_lines() {
        let lines: Vec<QuantLine> = QUANT.lines().filter_map(quant_line).collect();
        assert_eq!(lines.len(), 272);
        let emb = lines
            .iter()
            .find(|l| l.name == "token_embd.weight")
            .unwrap();
        assert_eq!(emb.to, "q8_0");
        assert_eq!(emb.from, "bf16");
        assert!((emb.mib_in - 54.0).abs() < 1e-9 && (emb.mib_out - 28.69).abs() < 1e-9);
        assert_eq!(emb.shape, vec![576, 49152]);
        let norm = lines
            .iter()
            .find(|l| l.name == "output_norm.weight")
            .unwrap();
        assert!(!norm.quantized);
        assert_eq!(norm.to, "f32");
        let t: Vec<_> = QUANT.lines().filter_map(totals).collect();
        assert_eq!(t[1].0, "quant");
        assert!((t[1].1 - 98.87).abs() < 1e-9);
        assert_eq!(t[1].2, Some(6.17));
        assert_eq!(QUANT.lines().filter_map(fallback).count(), 180);
    }

    #[test]
    fn parses_dry_run_variant() {
        let lines: Vec<QuantLine> = DRY.lines().filter_map(quant_line).collect();
        assert_eq!(lines.len(), 272);
        let emb = lines
            .iter()
            .find(|l| l.name == "token_embd.weight")
            .unwrap();
        assert_eq!(emb.to, "q8_0");
        assert!(emb.quantized);
        assert_eq!(DRY.lines().rev().find_map(totals).unwrap().2, Some(6.56));
    }

    #[test]
    fn parses_convert_lines_and_tqdm() {
        let tensors: Vec<_> = CONVERT.lines().filter_map(convert_tensor).collect();
        assert!(tensors.len() >= 270);
        let n = tensors
            .iter()
            .find(|t| t.0 == "blk.0.attn_norm.weight")
            .unwrap();
        assert_eq!((n.1.as_str(), n.2.as_str()), ("bfloat16", "F32"));
        assert_eq!(
            tqdm_percent(
                "Writing:  21%|██        | 56.6M/269M [00:00<00:00, 535Mbyte/s]Writing:  41%|████▏"
            ),
            Some(0.41)
        );
    }

    #[test]
    fn parses_real_imatrix_and_perplexity_runs() {
        let im = include_str!("../../tests/fixtures/imatrix-output.txt");
        assert_eq!(im.lines().find_map(total_chunks), Some(6));
        let last = im.lines().flat_map(chunks).last().unwrap();
        assert_eq!(last.0, 6);
        let base = perplexity(include_str!("../../tests/fixtures/ppl-base-output.txt"));
        assert_eq!(base.ppl, Some(17.5633));
        let kld_text = include_str!("../../tests/fixtures/ppl-kld-output.txt");
        let k = perplexity(kld_text);
        assert_eq!(k.ppl, Some(18.07824));
        assert_eq!(k.ppl_base, Some(17.520006));
        assert_eq!(k.kld_mean, Some(0.050057));
        assert_eq!(k.kld_p99, Some(0.256969));
        assert!((k.top1.unwrap() - 0.86667).abs() < 1e-9);
        assert_eq!(
            kld_text.lines().rev().find_map(kld_row).map(|r| r.0),
            Some(4)
        );
    }

    #[test]
    fn parses_real_onnx_builder_output() {
        let text = include_str!("../../tests/fixtures/onnx-builder-output.txt");
        let events: Vec<BuilderEvent> = text.lines().flat_map(builder_events).collect();
        assert!(events.contains(&BuilderEvent::Embedding));
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, BuilderEvent::Layer(_)))
                .count(),
            30
        );
        assert!(events.contains(&BuilderEvent::LmHead));
        assert!(events
            .iter()
            .any(|e| matches!(e, BuilderEvent::Quantizing(p) if *p > 0.99)));
        assert!(events.contains(&BuilderEvent::Saving));
    }

    #[test]
    fn parses_chunks_and_perplexity_summary() {
        assert_eq!(
            chunks("[1]15.3412,[2]14.1000,[3]nan,"),
            vec![(1, Some(15.3412)), (2, Some(14.1)), (3, None)]
        );
        let kld = "Mean PPL(Q)                   :  21.125 ±   0.512\nMean PPL(base)                :  20.738 ±   0.501\nMean PPL(Q)/PPL(base)         :   1.0186 ±   0.0011\nMean    KLD:   0.012453 ±   0.000127\nMaximum KLD:   4.528453\n99.0%   KLD:   0.124574\nMedian  KLD:   0.005217\nMean    Δp: -0.120 ± 0.008 %\nRMS Δp    :  3.140 ± 0.030 %\nSame top p: 95.785 ± 0.122 %\n";
        let s = perplexity(kld);
        assert_eq!(s.ppl, Some(21.125));
        assert_eq!(s.ppl_base, Some(20.738));
        assert_eq!(s.kld_mean, Some(0.012453));
        assert_eq!(s.kld_p99, Some(0.124574));
        assert!((s.top1.unwrap() - 0.95785).abs() < 1e-9);
        assert!((s.delta_p_mean.unwrap() + 0.0012).abs() < 1e-9);
        assert_eq!(
            perplexity("Final estimate: PPL = 9.6189 +/- 0.06400").ppl,
            Some(9.6189)
        );
    }
}

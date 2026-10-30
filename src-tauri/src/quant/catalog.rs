//! Quantization catalog: what each GGUF/MLX/ONNX option costs in bits and roughly what it
//! does to quality. GGUF numbers are calibrated from the installed `llama-quantize --help`
//! (sizes and perplexity deltas measured on Llama-3-8B), so they track the shipped version.

use crate::state::AppState;
use crate::toolchain::probe::QuantTypeCap;
use serde::Serialize;

/// Llama-3-8B shape used by llama.cpp's published ladder.
const L3_PARAMS: f64 = 8_030_261_248.0;
const L3_EMB: f64 = 128_256.0 * 4096.0;

/// Nominal bits per weight of a ggml tensor type (block scales included).
pub fn ggml_bits(t: &str) -> Option<f64> {
    Some(match t.to_uppercase().as_str() {
        "F32" => 32.0,
        "F16" | "BF16" => 16.0,
        "Q8_0" => 8.5,
        "Q6_K" => 6.5625,
        "Q5_K" => 5.5,
        "Q5_0" => 5.5,
        "Q5_1" => 6.0,
        "Q4_K" => 4.5,
        "Q4_0" => 4.5,
        "Q4_1" => 5.0,
        "IQ4_NL" => 4.5,
        "IQ4_XS" => 4.25,
        "Q3_K" => 3.4375,
        "IQ3_S" => 3.4375,
        "IQ3_XXS" => 3.0625,
        "Q2_K" => 2.625,
        "IQ2_S" => 2.5625,
        "IQ2_XS" => 2.3125,
        "IQ2_XXS" => 2.0625,
        "IQ1_M" => 1.75,
        "IQ1_S" => 1.5625,
        "TQ1_0" => 1.6875,
        "TQ2_0" => 2.0625,
        "MXFP4" => 4.25,
        "Q1_0" => 1.125,
        "Q2_0" => 2.25,
        _ => return None,
    })
}

/// The ggml tensor type most tensors get for a llama-quantize file type.
pub fn base_type(ftype: &str) -> String {
    let f = ftype.to_uppercase();
    for (prefix, t) in [
        ("Q2_K", "Q2_K"),
        ("Q3_K", "Q3_K"),
        ("Q4_K", "Q4_K"),
        ("Q5_K", "Q5_K"),
        ("Q6_K", "Q6_K"),
        ("MXFP4_MOE", "MXFP4"),
    ] {
        if f.starts_with(prefix) {
            return t.to_string();
        }
    }
    if f == "IQ3_M" || f == "IQ3_XS" {
        return "IQ3_S".into();
    }
    if f == "IQ2_M" {
        return "IQ2_S".into();
    }
    f
}

/// Types llama-quantize refuses to produce without an importance matrix.
pub fn requires_imatrix(ftype: &str) -> bool {
    matches!(
        ftype.to_uppercase().as_str(),
        "IQ1_S"
            | "IQ1_M"
            | "IQ2_XXS"
            | "IQ2_XS"
            | "IQ2_S"
            | "IQ2_M"
            | "IQ3_XXS"
            | "IQ3_XS"
            | "Q2_K_S"
            | "Q1_0"
    )
}

pub fn is_low_bit(ftype: &str) -> bool {
    let f = ftype.to_uppercase();
    f.starts_with("IQ1")
        || f.starts_with("IQ2")
        || f.starts_with("IQ3")
        || f.starts_with("Q2")
        || f.starts_with("Q3")
        || f.starts_with("TQ")
        || f == "Q1_0"
}

/// Type llama.cpp gives the output head (and tied embeddings) for a file type.
pub fn output_type(ftype: &str) -> &'static str {
    let f = ftype.to_uppercase();
    match f.as_str() {
        "F32" => "F32",
        "F16" => "F16",
        "BF16" => "BF16",
        "Q8_0" | "MXFP4_MOE" => "Q8_0",
        _ if f.starts_with("IQ1")
            || f.starts_with("IQ2")
            || f.starts_with("TQ")
            || f == "Q1_0"
            || f == "Q2_0" =>
        {
            "Q5_K"
        }
        _ => "Q6_K",
    }
}

/// Type llama.cpp gives untied token embeddings for a file type.
pub fn embedding_type(ftype: &str) -> String {
    let f = ftype.to_uppercase();
    if f.starts_with("IQ1")
        || f.starts_with("IQ2")
        || f.starts_with("TQ")
        || f == "Q1_0"
        || f == "Q2_0"
    {
        return "Q2_K".into();
    }
    if f == "IQ3_XXS" || f == "IQ3_XS" || f == "IQ3_S" || f == "IQ3_M" {
        return "IQ3_S".into();
    }
    if f == "MXFP4_MOE" {
        return "Q8_0".into();
    }
    base_type(&f)
}

#[derive(Debug, Clone, Serialize)]
pub struct GgufType {
    pub name: String,
    pub base: String,
    pub family: &'static str,
    /// Effective bits/weight of transformer-block tensors (mixes like _M included).
    pub body_bpw: f64,
    /// Whole-file bits/weight on Llama-3-8B when known.
    pub file_bpw_8b: Option<f64>,
    /// Perplexity increase on Llama-3-8B (published or interpolated).
    pub ppl_delta_8b: Option<f64>,
    pub ppl_estimated: bool,
    pub requires_imatrix: bool,
    pub alias_of: Option<String>,
    pub description: String,
    pub kb: String,
}

fn family(name: &str) -> &'static str {
    let n = name.to_uppercase();
    if n.starts_with("IQ") {
        "i-quant"
    } else if n.contains("_K") {
        "k-quant"
    } else if n.starts_with("TQ") {
        "ternary"
    } else if n.starts_with('F') || n == "BF16" || n == "COPY" {
        "float"
    } else if n.starts_with("MXFP") {
        "microscaling"
    } else {
        "legacy"
    }
}

/// Published ladder points: (body bpw, Δppl) used to interpolate unknown types.
fn ladder(types: &[GgufType]) -> Vec<(f64, f64)> {
    let mut pts: Vec<(f64, f64)> = types
        .iter()
        .filter(|t| !t.ppl_estimated && t.family == "k-quant")
        .filter_map(|t| t.ppl_delta_8b.map(|p| (t.body_bpw, p)))
        .collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    pts
}

/// Log-linear interpolation of Δppl over bpw.
pub fn interpolate_ppl(pts: &[(f64, f64)], bpw: f64) -> Option<f64> {
    if pts.len() < 2 {
        return None;
    }
    let ln = |p: f64| p.max(1e-4).ln();
    let (lo, hi) = if bpw <= pts[0].0 {
        (pts[0], pts[1])
    } else if bpw >= pts[pts.len() - 1].0 {
        (pts[pts.len() - 2], pts[pts.len() - 1])
    } else {
        let i = pts.iter().position(|p| p.0 >= bpw).unwrap_or(1).max(1);
        (pts[i - 1], pts[i])
    };
    let t = (bpw - lo.0) / (hi.0 - lo.0);
    Some((ln(lo.1) + t * (ln(hi.1) - ln(lo.1))).exp())
}

/// Builds the GGUF catalog from probed capabilities (falls back to a static list).
pub fn gguf_types(st: &AppState) -> Vec<GgufType> {
    let probed: Vec<QuantTypeCap> = crate::toolchain::capability(st, "llama_cpp", "quant_types")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_else(|| {
            crate::toolchain::probe::parse_quant_types(include_str!(
                "../../tests/fixtures/llama-quantize-help.txt"
            ))
        });
    build_gguf_types(&probed)
}

pub fn build_gguf_types(probed: &[QuantTypeCap]) -> Vec<GgufType> {
    let body = L3_PARAMS - 2.0 * L3_EMB;
    let mut out: Vec<GgufType> = probed
        .iter()
        .filter(|t| t.name != "COPY")
        .map(|t| {
            let base = base_type(&t.name);
            let nominal = ggml_bits(&base).or(t.bpw).unwrap_or(16.0);
            let (body_bpw, file_bpw) = match t.size_gib_8b {
                Some(gib) if !matches!(t.name.as_str(), "F16" | "BF16" | "F32") => {
                    let total_bits = gib * 1_073_741_824.0 * 8.0;
                    let out_bits = ggml_bits(output_type(&t.name)).unwrap_or(6.5625);
                    let emb_bits = ggml_bits(&embedding_type(&t.name)).unwrap_or(nominal);
                    let b = (total_bits - L3_EMB * out_bits - L3_EMB * emb_bits) / body;
                    (
                        b.clamp(nominal * 0.9, nominal * 1.25),
                        Some(total_bits / L3_PARAMS),
                    )
                }
                _ => (t.bpw.unwrap_or(nominal), None),
            };
            GgufType {
                name: t.name.clone(),
                family: family(&t.name),
                body_bpw,
                file_bpw_8b: file_bpw,
                ppl_delta_8b: t.ppl_delta.map(|p| p.max(0.0)),
                ppl_estimated: false,
                requires_imatrix: requires_imatrix(&t.name),
                alias_of: t.alias_of.clone(),
                description: t.description.clone(),
                kb: format!("gguf.qtype.{}", t.name),
                base,
            }
        })
        .collect();
    let pts = ladder(&out);
    for t in out.iter_mut() {
        if t.ppl_delta_8b.is_none() && t.family != "float" {
            // I-quants are built with an importance matrix and beat k-quants at equal bpw.
            let factor = match t.family {
                "i-quant" => 0.8,
                "ternary" => 1.6,
                _ => 1.0,
            };
            t.ppl_delta_8b = interpolate_ppl(&pts, t.body_bpw).map(|p| p * factor);
            t.ppl_estimated = true;
        }
        if t.family == "float" {
            t.ppl_delta_8b = Some(0.0);
        }
    }
    out
}

/// Plain-language quality tier from an expected perplexity increase.
pub fn quality_tier(ppl_delta: f64) -> (&'static str, u8) {
    match ppl_delta {
        d if d <= 0.03 => ("Near-lossless", 5),
        d if d <= 0.08 => ("Excellent", 5),
        d if d <= 0.3 => ("Very good", 4),
        d if d <= 0.75 => ("Good", 3),
        d if d <= 1.8 => ("Noticeable loss", 2),
        _ => ("Heavy loss", 1),
    }
}

/// Smaller models lose more from the same quantization (rough scaling).
pub fn size_penalty(params: f64) -> f64 {
    (8.0e9 / params.max(1e7)).powf(0.35).clamp(1.0, 3.0)
}

/// MLX overhead per weight for a mode and group size.
pub fn mlx_bpw(bits: f64, group_size: u32, mode: &str) -> f64 {
    match mode {
        "mxfp4" => 4.0 + 8.0 / 32.0,
        "nvfp4" => 4.0 + 8.0 / 16.0,
        "mxfp8" => 8.0 + 8.0 / 32.0,
        _ => bits + 32.0 / group_size.max(1) as f64,
    }
}

/// Expected Δppl for a generic weight-only scheme at an effective bpw (relative to k-quants).
pub fn generic_ppl(types: &[GgufType], bpw: f64, factor: f64) -> Option<f64> {
    interpolate_ppl(&ladder(types), bpw).map(|p| p * factor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types() -> Vec<GgufType> {
        build_gguf_types(&crate::toolchain::probe::parse_quant_types(include_str!(
            "../../tests/fixtures/llama-quantize-help.txt"
        )))
    }

    #[test]
    fn calibrates_body_bpw_from_published_sizes() {
        let t = types();
        let q4km = t.iter().find(|x| x.name == "Q4_K_M").unwrap();
        assert!((q4km.body_bpw - 4.80).abs() < 0.05, "{}", q4km.body_bpw);
        assert!((q4km.file_bpw_8b.unwrap() - 4.90).abs() < 0.05);
        let q8 = t.iter().find(|x| x.name == "Q8_0").unwrap();
        assert!((q8.body_bpw - 8.5).abs() < 0.1);
    }

    #[test]
    fn interpolates_iquant_quality_and_flags_imatrix() {
        let t = types();
        let iq3m = t.iter().find(|x| x.name == "IQ3_M").unwrap();
        assert!(iq3m.ppl_estimated);
        let p = iq3m.ppl_delta_8b.unwrap();
        assert!(p > 0.3 && p < 1.5, "{p}");
        assert!(
            t.iter()
                .find(|x| x.name == "IQ2_XXS")
                .unwrap()
                .requires_imatrix
        );
        assert!(
            !t.iter()
                .find(|x| x.name == "Q4_K_M")
                .unwrap()
                .requires_imatrix
        );
        assert_eq!(quality_tier(0.1754).0, "Very good");
    }

    #[test]
    fn mlx_overheads() {
        assert!((mlx_bpw(4.0, 64, "affine") - 4.5).abs() < 1e-9);
        assert!((mlx_bpw(4.0, 32, "mxfp4") - 4.25).abs() < 1e-9);
    }
}

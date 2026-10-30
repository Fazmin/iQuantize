//! Per-tensor size projection for a recipe. Works from real tensor headers when the model is
//! downloaded, or a synthetic layout derived from config.json otherwise.

use super::catalog::{self, GgufType};
use super::recipe::{GgufRecipe, MlxVariant, OnnxVariant};
use crate::models::config::ArchInfo;
use crate::models::tensors::TensorInfo;
use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Embed,
    Output,
    Norm,
    Body,
}

#[derive(Debug, Clone)]
pub struct Classified {
    pub role: Role,
    pub block: Option<u64>,
    pub gguf_name: String,
}

/// Maps a Hugging Face tensor name to llama.cpp's naming (best effort) and a role.
pub fn classify(name: &str, shape: &[u64]) -> Classified {
    static HF_BLOCK: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"(?:^|\.)(?:layers|h|blocks)\.(\d+)\.").unwrap());
    static GGUF_BLOCK: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"^blk\.(\d+)\.").unwrap());
    let n = name.trim_end_matches(".weight");
    let one_d = shape.len() <= 1;
    let block = HF_BLOCK
        .captures(n)
        .and_then(|c| c[1].parse().ok())
        .or_else(|| GGUF_BLOCK.captures(n).and_then(|c| c[1].parse().ok()));
    let kind = |pats: &[(&str, &str)]| {
        pats.iter()
            .find(|(p, _)| n.contains(p))
            .map(|(_, k)| k.to_string())
    };
    let gguf_kind = kind(&[
        ("q_proj", "attn_q"),
        ("k_proj", "attn_k"),
        ("v_proj", "attn_v"),
        ("o_proj", "attn_output"),
        ("gate_up_proj", "ffn_gate_up"),
        ("gate_proj", "ffn_gate"),
        ("up_proj", "ffn_up"),
        ("down_proj", "ffn_down"),
        ("input_layernorm", "attn_norm"),
        ("post_attention_layernorm", "ffn_norm"),
        ("attn_", ""),
        ("ffn_", ""),
    ]);
    let gguf_name =
        if n.starts_with("blk.") || n == "token_embd" || n == "output" || n == "output_norm" {
            n.to_string()
        } else if n.contains("embed_tokens") || n.ends_with("wte") || n.contains("word_embeddings")
        {
            "token_embd".into()
        } else if n.contains("lm_head") {
            "output".into()
        } else if let (Some(b), Some(k)) = (block, gguf_kind.filter(|k| !k.is_empty())) {
            let expert = if n.contains("experts") { "_exps" } else { "" };
            format!("blk.{b}.{k}{expert}")
        } else {
            n.to_string()
        };
    let role = if gguf_name == "token_embd" {
        Role::Embed
    } else if gguf_name == "output" {
        Role::Output
    } else if one_d || n.contains("norm") || n.ends_with(".bias") {
        Role::Norm
    } else {
        Role::Body
    };
    Classified {
        role,
        block,
        gguf_name,
    }
}

/// Layer selection used by llama.cpp and mlx-lm to give some attn_v/ffn_down layers more bits.
pub fn use_more_bits(i: u64, n: u64) -> bool {
    i < n / 8 || i >= 7 * n / 8 || (i >= n / 8 && (i - n / 8) % 3 == 2)
}

/// Builds an approximate tensor list from config.json when headers aren't available.
pub fn synthetic_tensors(a: &ArchInfo) -> Vec<TensorInfo> {
    let (Some(l), Some(hd), Some(v)) = (a.layers, a.hidden_size, a.vocab_size) else {
        return vec![];
    };
    let ff = a.intermediate_size.unwrap_or(4 * hd);
    let kv = a.kv_heads.zip(a.head_dim).map(|(k, d)| k * d).unwrap_or(hd);
    let q = a.heads.zip(a.head_dim).map(|(h, d)| h * d).unwrap_or(hd);
    let e = a.experts.unwrap_or(1).max(1);
    let t = |name: String, shape: Vec<u64>| {
        let n: u64 = shape.iter().product();
        TensorInfo {
            name,
            shape,
            dtype: "BF16".into(),
            n_elements: n,
            bytes: n * 2,
            bits: 16.0,
        }
    };
    let mut out = vec![t("model.embed_tokens.weight".into(), vec![v, hd])];
    for i in 0..l {
        let p = format!("model.layers.{i}");
        out.push(t(format!("{p}.self_attn.q_proj.weight"), vec![q, hd]));
        out.push(t(format!("{p}.self_attn.k_proj.weight"), vec![kv, hd]));
        out.push(t(format!("{p}.self_attn.v_proj.weight"), vec![kv, hd]));
        out.push(t(format!("{p}.self_attn.o_proj.weight"), vec![hd, q]));
        let mlp = if e > 1 {
            format!("{p}.mlp.experts")
        } else {
            format!("{p}.mlp")
        };
        out.push(t(format!("{mlp}.gate_proj.weight"), vec![ff * e, hd]));
        out.push(t(format!("{mlp}.up_proj.weight"), vec![ff * e, hd]));
        out.push(t(format!("{mlp}.down_proj.weight"), vec![hd, ff * e]));
        out.push(t(format!("{p}.input_layernorm.weight"), vec![hd]));
        out.push(t(format!("{p}.post_attention_layernorm.weight"), vec![hd]));
    }
    out.push(t("model.norm.weight".into(), vec![hd]));
    if !a.tied_embeddings {
        out.push(t("lm_head.weight".into(), vec![v, hd]));
    }
    out
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Estimate {
    pub bytes: u64,
    pub params: u64,
    pub bpw: f64,
    pub embed_bytes: u64,
    pub output_bytes: u64,
    pub body_bytes: u64,
    pub norm_bytes: u64,
    /// Fraction of parameters stored at ≥6 bits (protected tensors).
    pub high_precision_share: f64,
}

struct Acc {
    e: Estimate,
    hi_params: u64,
}

impl Acc {
    fn new() -> Self {
        Self {
            e: Estimate::default(),
            hi_params: 0,
        }
    }
    fn add(&mut self, role: Role, n: u64, bits: f64) {
        let b = (n as f64 * bits / 8.0) as u64;
        self.e.bytes += b;
        self.e.params += n;
        if bits >= 6.0 && role != Role::Norm {
            self.hi_params += n;
        }
        match role {
            Role::Embed => self.e.embed_bytes += b,
            Role::Output => self.e.output_bytes += b,
            Role::Body => self.e.body_bytes += b,
            Role::Norm => self.e.norm_bytes += b,
        }
    }
    fn done(mut self) -> Estimate {
        self.e.bpw = if self.e.params > 0 {
            self.e.bytes as f64 * 8.0 / self.e.params as f64
        } else {
            0.0
        };
        self.e.high_precision_share = if self.e.params > 0 {
            self.hi_params as f64 / self.e.params as f64
        } else {
            0.0
        };
        self.e
    }
}

fn layer_count(tensors: &[TensorInfo]) -> u64 {
    tensors
        .iter()
        .filter_map(|t| classify(&t.name, &t.shape).block)
        .max()
        .map(|m| m + 1)
        .unwrap_or(1)
}

fn has_output(tensors: &[TensorInfo]) -> bool {
    tensors
        .iter()
        .any(|t| classify(&t.name, &t.shape).role == Role::Output)
}

/// llama.cpp falls back to a 32-wide block type when a row isn't a multiple of 256
/// (e.g. hidden size 576), which makes small models bigger than the type name suggests.
pub fn fallback_bits(t: &str, ncols: u64) -> Option<f64> {
    let t = t.to_uppercase();
    let block256 = t.contains("_K") || t.starts_with("IQ") && t != "IQ4_NL" || t.starts_with("TQ");
    if block256 && ncols % 256 != 0 {
        return Some(match t.as_str() {
            "Q4_K" => 5.5,
            "Q5_K" => 6.0,
            "Q6_K" | "Q8_K" => 8.5,
            _ => 4.5,
        });
    }
    if !block256 && catalog::ggml_bits(&t).map(|b| b < 16.0).unwrap_or(false) && ncols % 32 != 0 {
        return Some(16.0);
    }
    None
}

/// Projects a GGUF file type over the tensor list.
pub fn gguf(
    tensors: &[TensorInfo],
    ftype: &str,
    recipe: &GgufRecipe,
    types: &[GgufType],
) -> Estimate {
    let cat = types.iter().find(|t| t.name.eq_ignore_ascii_case(ftype));
    let base = catalog::base_type(ftype);
    let nominal = catalog::ggml_bits(&base)
        .or(cat.map(|c| c.body_bpw))
        .unwrap_or(16.0);
    let body_bpw = if recipe.pure {
        nominal
    } else {
        cat.map(|c| c.body_bpw).unwrap_or(nominal)
    };
    let moe = ftype.eq_ignore_ascii_case("MXFP4_MOE");
    let tied = !has_output(tensors);
    let out_type = recipe
        .output_tensor_type
        .clone()
        .unwrap_or_else(|| catalog::output_type(ftype).to_string());
    let emb_type = recipe
        .token_embedding_type
        .clone()
        .unwrap_or_else(|| catalog::embedding_type(ftype));
    let rules: Vec<(Regex, String)> = recipe
        .tensor_types
        .iter()
        .filter_map(|r| Some((Regex::new(&r.pattern).ok()?, r.type_name.to_uppercase())))
        .collect();
    // Bits for a tensor stored as `ty`, honouring the k-quant fallback for this row width.
    let typed = |ty: &str, ncols: u64| {
        fallback_bits(ty, ncols)
            .or_else(|| catalog::ggml_bits(ty))
            .unwrap_or(nominal)
    };
    let mut acc = Acc::new();
    for t in tensors {
        let c = classify(&t.name, &t.shape);
        let src = if t.bits > 0.0 { t.bits } else { 16.0 };
        let ncols = t.shape.last().copied().unwrap_or(256);
        let bits = match c.role {
            Role::Norm => 32.0,
            Role::Output => {
                if recipe.leave_output_tensor {
                    src
                } else {
                    typed(&out_type, ncols)
                }
            }
            Role::Embed if tied => {
                if recipe.leave_output_tensor {
                    src
                } else {
                    typed(&out_type, ncols)
                }
            }
            Role::Embed => typed(&emb_type, ncols),
            Role::Body => {
                if let Some((_, ty)) = rules.iter().find(|(re, _)| re.is_match(&c.gguf_name)) {
                    typed(ty, ncols)
                } else if moe {
                    if c.gguf_name.contains("_exps") {
                        4.25
                    } else {
                        8.5
                    }
                } else {
                    // Calibrated mix (e.g. _M bumps for attn_v/ffn_down) scaled onto any fallback type.
                    fallback_bits(&base, ncols)
                        .map(|fb| fb * (body_bpw / nominal).max(1.0))
                        .unwrap_or(body_bpw)
                }
            }
        };
        acc.add(c.role, t.n_elements, bits);
    }
    acc.done()
}

pub fn mlx(tensors: &[TensorInfo], v: &MlxVariant, rules: &[(Regex, u32)]) -> Estimate {
    let n_layers = layer_count(tensors);
    let tied = !has_output(tensors);
    let (low, high) = match v.recipe.as_deref() {
        Some(r) if r.starts_with("mixed_") => {
            let parts: Vec<f64> = r
                .trim_start_matches("mixed_")
                .split('_')
                .filter_map(|x| x.parse().ok())
                .collect();
            (
                parts.first().copied().unwrap_or(v.bits as f64),
                parts.get(1).copied().unwrap_or(v.bits as f64),
            )
        }
        _ => (v.bits as f64, v.bits as f64),
    };
    let bpw = |b: f64| catalog::mlx_bpw(b, v.group_size, &v.mode);
    let dtype_bits = match v.dtype.as_deref() {
        Some("float32") => 32.0,
        _ => 16.0,
    };
    let mut acc = Acc::new();
    for t in tensors {
        let c = classify(&t.name, &t.shape);
        let divisible = t
            .shape
            .last()
            .map(|d| d % v.group_size as u64 == 0)
            .unwrap_or(false);
        let bits = match c.role {
            Role::Norm => dtype_bits,
            _ if !divisible => dtype_bits,
            _ => {
                if let Some((_, b)) = rules.iter().find(|(re, _)| re.is_match(&t.name)) {
                    if *b == 0 {
                        dtype_bits
                    } else {
                        bpw(*b as f64)
                    }
                } else {
                    match c.role {
                        Role::Output => bpw(high),
                        Role::Embed if tied => bpw(high),
                        Role::Body
                            if high != low
                                && (t.name.contains("v_proj") || t.name.contains("down_proj"))
                                && c.block.map(|b| use_more_bits(b, n_layers)).unwrap_or(false) =>
                        {
                            bpw(high)
                        }
                        _ => bpw(low),
                    }
                }
            }
        };
        acc.add(c.role, t.n_elements, bits);
    }
    acc.done()
}

pub fn onnx(tensors: &[TensorInfo], v: &OnnxVariant) -> Estimate {
    let block = v.block_size.max(16) as f64;
    // Measured on builder output: block scales are stored in the I/O dtype (fp32 on CPU,
    // fp16 elsewhere) and every block carries a zero point.
    let cpu = v.ep == "cpu";
    let io_bits =
        if v.precision == "fp32" || (cpu && v.precision != "fp16" && v.precision != "bf16") {
            32.0
        } else {
            16.0
        };
    let scale_bits = if cpu { 32.0 } else { 16.0 };
    let q = |prec: &str| -> f64 {
        match prec {
            "int4" => 4.0 + (scale_bits + 4.0) / block,
            "int8" => 8.0 + (scale_bits + 8.0) / block,
            "fp16" | "bf16" => 16.0,
            _ => 32.0,
        }
    };
    let head = if v.head_int8 && v.precision == "int4" {
        q("int8")
    } else {
        q(&v.precision)
    };
    let tied = !has_output(tensors);
    let quantized = v.precision == "int4" || v.precision == "int8";
    let mut acc = Acc::new();
    for t in tensors {
        let c = classify(&t.name, &t.shape);
        match c.role {
            Role::Norm => acc.add(Role::Norm, t.n_elements, io_bits),
            // Tied embeddings are stored once, quantized, and shared with the LM head.
            Role::Embed if tied && quantized => acc.add(Role::Output, t.n_elements, head),
            Role::Embed if tied => {
                acc.add(Role::Embed, t.n_elements, io_bits);
                acc.add(Role::Output, t.n_elements, head);
            }
            Role::Embed => acc.add(Role::Embed, t.n_elements, io_bits),
            Role::Output => acc.add(Role::Output, t.n_elements, head),
            Role::Body => acc.add(Role::Body, t.n_elements, q(&v.precision)),
        }
    }
    acc.done()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::config::analyze;
    use serde_json::json;

    fn llama3_8b() -> Vec<TensorInfo> {
        synthetic_tensors(&analyze(&json!({
            "hidden_size": 4096, "intermediate_size": 14336, "num_attention_heads": 32, "num_key_value_heads": 8,
            "num_hidden_layers": 32, "vocab_size": 128256, "tie_word_embeddings": false
        })))
    }

    #[test]
    fn classifies_hf_and_gguf_names() {
        let c = classify("model.layers.3.self_attn.v_proj.weight", &[1024, 4096]);
        assert_eq!(c.gguf_name, "blk.3.attn_v");
        assert_eq!(c.role, Role::Body);
        assert_eq!(classify("lm_head.weight", &[10, 10]).role, Role::Output);
        assert_eq!(classify("model.norm.weight", &[4096]).role, Role::Norm);
        assert_eq!(classify("token_embd.weight", &[10, 10]).role, Role::Embed);
    }

    #[test]
    fn gguf_estimate_matches_published_llama3_size_within_3_percent() {
        let types = catalog::build_gguf_types(&crate::toolchain::probe::parse_quant_types(
            include_str!("../../tests/fixtures/llama-quantize-help.txt"),
        ));
        let t = llama3_8b();
        for (ftype, gib) in [
            ("Q4_K_M", 4.58),
            ("Q8_0", 7.96),
            ("Q3_K_M", 3.74),
            ("Q5_K_M", 5.33),
        ] {
            let e = gguf(&t, ftype, &GgufRecipe::default(), &types);
            let want = gib * 1_073_741_824.0;
            let err = (e.bytes as f64 - want).abs() / want;
            assert!(err < 0.03, "{ftype}: {} vs {want} ({err})", e.bytes);
        }
    }

    #[test]
    fn gguf_estimate_models_kquant_fallback_on_small_models() {
        // SmolLM2-135M (hidden 576): real Q4_K_M from b11935 is 98.87 MiB.
        let a = analyze(
            &json!({ "hidden_size": 576, "intermediate_size": 1536, "num_attention_heads": 9, "num_key_value_heads": 3,
            "num_hidden_layers": 30, "vocab_size": 49152, "tie_word_embeddings": true }),
        );
        let types = catalog::build_gguf_types(&crate::toolchain::probe::parse_quant_types(
            include_str!("../../tests/fixtures/llama-quantize-help.txt"),
        ));
        let e = gguf(
            &synthetic_tensors(&a),
            "Q4_K_M",
            &GgufRecipe::default(),
            &types,
        );
        let want = 98.87 * 1_048_576.0;
        assert!(
            (e.bytes as f64 - want).abs() / want < 0.05,
            "{} vs {want}",
            e.bytes
        );
        assert_eq!(fallback_bits("Q6_K", 576), Some(8.5));
        assert_eq!(fallback_bits("Q4_K", 1536), None);
    }

    #[test]
    fn mlx_and_onnx_estimates_are_plausible() {
        let t = llama3_8b();
        let v = MlxVariant {
            bits: 4,
            group_size: 64,
            mode: "affine".into(),
            recipe: None,
            dtype: None,
        };
        let e = mlx(&t, &v, &[]);
        assert!((e.bpw - 4.5).abs() < 0.05, "{}", e.bpw);
        let mixed = mlx(
            &t,
            &MlxVariant {
                recipe: Some("mixed_3_6".into()),
                bits: 3,
                ..v.clone()
            },
            &[],
        );
        assert!(mixed.bpw > 3.6 && mixed.bpw < 4.6, "{}", mixed.bpw);
        let o = onnx(
            &t,
            &OnnxVariant {
                precision: "int4".into(),
                ep: "cpu".into(),
                block_size: 32,
                is_symmetric: true,
                ..Default::default()
            },
        );
        assert!(o.bpw > 5.0 && o.bpw < 8.0, "{}", o.bpw); // untied fp32 embeddings on CPU inflate the total
                                                          // SmolLM2-135M int4 k_quant + INT8 head on CPU: real weights were 102.99 MB.
        let a = analyze(
            &json!({ "hidden_size": 576, "intermediate_size": 1536, "num_attention_heads": 9, "num_key_value_heads": 3,
            "num_hidden_layers": 30, "vocab_size": 49152, "tie_word_embeddings": true }),
        );
        let small = onnx(
            &synthetic_tensors(&a),
            &OnnxVariant {
                head_int8: true,
                ..Default::default()
            },
        );
        assert!(
            (small.bytes as f64 - 102.99e6).abs() / 102.99e6 < 0.05,
            "{}",
            small.bytes
        );
    }

    #[test]
    fn more_bits_layer_rule() {
        let picked: Vec<u64> = (0..32).filter(|&i| use_more_bits(i, 32)).collect();
        assert!(picked.contains(&0) && picked.contains(&31) && picked.contains(&6));
        assert!(!picked.contains(&5));
    }
}

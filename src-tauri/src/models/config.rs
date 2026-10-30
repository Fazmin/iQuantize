//! Derives the facts the estimator and UI need from a Hugging Face `config.json`.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize)]
pub struct ArchInfo {
    pub architecture: Option<String>,
    pub model_type: Option<String>,
    pub layers: Option<u64>,
    pub hidden_size: Option<u64>,
    pub intermediate_size: Option<u64>,
    pub heads: Option<u64>,
    pub kv_heads: Option<u64>,
    pub head_dim: Option<u64>,
    pub vocab_size: Option<u64>,
    pub context_length: Option<u64>,
    pub tied_embeddings: bool,
    pub torch_dtype: Option<String>,
    pub experts: Option<u64>,
    pub experts_per_token: Option<u64>,
    /// Present when the checkpoint is already quantized (AWQ, GPTQ, FP8, bitsandbytes…).
    pub quantization: Option<String>,
    pub multimodal: bool,
}

fn u(v: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|k| {
        v.get(*k)
            .and_then(|x| x.as_u64().or_else(|| x.as_f64().map(|f| f as u64)))
    })
}

fn s(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(|x| x.as_str().map(str::to_string)))
}

pub fn analyze(cfg: &Value) -> ArchInfo {
    // Multimodal wrappers keep the language model under text_config / llm_config.
    let text = ["text_config", "llm_config", "language_config"]
        .iter()
        .find_map(|k| cfg.get(*k).filter(|v| v.is_object()))
        .unwrap_or(cfg);
    let pick = |keys: &[&str]| u(text, keys).or_else(|| u(cfg, keys));
    let heads = pick(&["num_attention_heads", "n_head", "n_heads", "num_heads"]);
    let hidden = pick(&["hidden_size", "n_embd", "d_model", "dim"]);
    let head_dim = pick(&["head_dim"]).or_else(|| match (hidden, heads) {
        (Some(h), Some(n)) if n > 0 => Some(h / n),
        _ => None,
    });
    let quant = cfg
        .get("quantization_config")
        .map(|q| s(q, &["quant_method", "quant_type"]).unwrap_or_else(|| "unknown".into()));
    ArchInfo {
        architecture: cfg
            .get("architectures")
            .and_then(|a| a.get(0))
            .and_then(|a| a.as_str())
            .map(str::to_string),
        model_type: s(cfg, &["model_type"]),
        layers: pick(&["num_hidden_layers", "n_layer", "n_layers", "num_layers"]),
        hidden_size: hidden,
        intermediate_size: pick(&["intermediate_size", "ffn_hidden_size", "n_inner"]),
        heads,
        kv_heads: pick(&[
            "num_key_value_heads",
            "num_kv_heads",
            "n_head_kv",
            "multi_query_group_num",
        ])
        .or(heads),
        head_dim,
        vocab_size: pick(&["vocab_size", "padded_vocab_size"]),
        context_length: pick(&[
            "max_position_embeddings",
            "n_positions",
            "max_sequence_length",
            "seq_length",
            "n_ctx",
        ]),
        tied_embeddings: text
            .get("tie_word_embeddings")
            .or_else(|| cfg.get("tie_word_embeddings"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        torch_dtype: s(text, &["torch_dtype", "dtype"])
            .or_else(|| s(cfg, &["torch_dtype", "dtype"])),
        experts: pick(&[
            "num_local_experts",
            "num_experts",
            "n_routed_experts",
            "moe_num_experts",
        ]),
        experts_per_token: pick(&[
            "num_experts_per_tok",
            "num_experts_per_token",
            "moe_top_k",
            "top_k",
        ]),
        quantization: quant,
        multimodal: !std::ptr::eq(text, cfg) || cfg.get("vision_config").is_some(),
    }
}

/// Bytes of KV cache for a context length (fp16 cache unless `bytes_per` given).
pub fn kv_cache_bytes(a: &ArchInfo, ctx: u64, bytes_per: f64) -> Option<u64> {
    let layers = a.layers?;
    let kv = a.kv_heads?;
    let hd = a.head_dim?;
    Some((2.0 * layers as f64 * kv as f64 * hd as f64 * ctx as f64 * bytes_per) as u64)
}

/// Rough parameter count when no tensor data is available.
pub fn estimate_params(a: &ArchInfo) -> Option<u64> {
    let (l, h, v) = (a.layers?, a.hidden_size?, a.vocab_size?);
    let ff = a.intermediate_size.unwrap_or(4 * h);
    let kv_dim = a.kv_heads.zip(a.head_dim).map(|(k, d)| k * d).unwrap_or(h);
    let attn = h * h * 2 + h * kv_dim * 2;
    let experts = a.experts.unwrap_or(1).max(1);
    let mlp = 3 * h * ff * experts;
    let embed = v * h * if a.tied_embeddings { 1 } else { 2 };
    Some(l * (attn + mlp) + embed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn analyzes_llama_style_config() {
        let cfg = json!({
            "architectures": ["LlamaForCausalLM"], "model_type": "llama", "hidden_size": 4096, "intermediate_size": 14336,
            "num_attention_heads": 32, "num_key_value_heads": 8, "num_hidden_layers": 32, "vocab_size": 128256,
            "max_position_embeddings": 131072, "torch_dtype": "bfloat16", "tie_word_embeddings": false
        });
        let a = analyze(&cfg);
        assert_eq!(a.head_dim, Some(128));
        assert_eq!(a.kv_heads, Some(8));
        // Llama-3-8B: 8k context fp16 KV = 2*32*8*128*8192*2 bytes = 1 GiB
        assert_eq!(kv_cache_bytes(&a, 8192, 2.0), Some(1_073_741_824));
        let p = estimate_params(&a).unwrap();
        assert!((7.9e9..8.2e9).contains(&(p as f64)), "{p}");
    }

    #[test]
    fn handles_multimodal_text_config_and_quantized_flags() {
        let cfg = json!({ "architectures": ["Gemma3ForConditionalGeneration"], "model_type": "gemma3",
            "text_config": { "hidden_size": 2560, "num_hidden_layers": 34, "num_attention_heads": 8, "num_key_value_heads": 4, "head_dim": 256, "vocab_size": 262208 },
            "vision_config": {}, "quantization_config": { "quant_method": "fp8" } });
        let a = analyze(&cfg);
        assert_eq!(a.layers, Some(34));
        assert_eq!(a.head_dim, Some(256));
        assert!(a.multimodal);
        assert_eq!(a.quantization.as_deref(), Some("fp8"));
    }
}

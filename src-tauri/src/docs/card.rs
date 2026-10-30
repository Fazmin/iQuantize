//! Deterministic Hugging Face model card built only from provenance data.

use serde_json::Value;
use std::fmt::Write;

fn human(b: f64) -> String {
    crate::toolchain::download::human(b as u64)
}

fn num(v: &Value, digits: usize) -> String {
    v.as_f64()
        .map(|x| format!("{x:.digits$}"))
        .unwrap_or_else(|| "—".into())
}

fn pct(v: &Value) -> String {
    v.as_f64()
        .map(|x| format!("{:.1}%", x * 100.0))
        .unwrap_or_else(|| "—".into())
}

fn params(n: &Value) -> String {
    match n.as_f64() {
        Some(x) if x >= 1e9 => format!("{:.1}B", x / 1e9),
        Some(x) if x >= 1e6 => format!("{:.0}M", x / 1e6),
        Some(x) => format!("{x:.0}"),
        None => "—".into(),
    }
}

fn use_when(format: &str, variant: &str) -> &'static str {
    let v = variant.to_uppercase();
    match format {
        "gguf" if v.starts_with("Q8") || v == "F16" || v == "BF16" => {
            "Near-original quality; plenty of memory"
        }
        "gguf" if v.starts_with("Q6") || v.starts_with("Q5") => "High quality with a moderate size",
        "gguf" if v.starts_with("Q4") || v.starts_with("IQ4") => "Best balance for most people",
        "gguf" if v.starts_with("Q3") || v.starts_with("IQ3") => "Tight memory; some quality loss",
        "gguf" => "Very tight memory; noticeable quality loss",
        "mlx" if v.starts_with('8') => "Near-original quality on Apple Silicon",
        "mlx" if v.starts_with('6') || v.starts_with('5') || v.contains("4_6") => {
            "High quality on Apple Silicon"
        }
        "mlx" => "Fast and compact on Apple Silicon",
        _ if v.starts_with("INT4") => "Compact ONNX Runtime deployment",
        _ if v.starts_with("INT8") => "Higher-quality ONNX Runtime deployment",
        _ => "Full-precision ONNX export",
    }
}

/// Builds the README.md. `repo` fills usage snippets (falls back to a placeholder).
pub fn template(p: &Value, repo: Option<&str>) -> String {
    let m = &p["model"];
    let outs: Vec<&Value> = p["outputs"]
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let formats: std::collections::BTreeSet<&str> =
        outs.iter().filter_map(|o| o["format"].as_str()).collect();
    let name = m["name"].as_str().unwrap_or("Model");
    let base = m["repo_id"].as_str();
    let repo = repo.unwrap_or("<your-username>/<repo-name>");
    let mut s = String::new();

    // Front matter.
    let _ = writeln!(s, "---");
    if let Some(b) = base {
        let _ = writeln!(s, "base_model: {b}");
        let _ = writeln!(s, "base_model_relation: quantized");
    }
    if let Some(l) = m["license"].as_str() {
        let _ = writeln!(s, "license: {l}");
        if let Some(ln) = m["license_name"].as_str() {
            let _ = writeln!(s, "license_name: {ln}");
        }
    }
    let _ = writeln!(s, "pipeline_tag: text-generation");
    if formats.len() == 1 && formats.contains("mlx") {
        let _ = writeln!(s, "library_name: mlx");
    }
    let mut tags = vec!["quantized".to_string(), "iquantize".to_string()];
    for f in &formats {
        match *f {
            "gguf" => tags.extend(["gguf".into(), "llama-cpp".into()]),
            "mlx" => tags.push("mlx".into()),
            "onnx" => tags.extend(["onnx".into(), "onnxruntime-genai".into()]),
            _ => {}
        }
    }
    if outs.iter().any(|o| !o["imatrix"].is_null()) {
        tags.push("imatrix".into());
    }
    let _ = writeln!(s, "tags:");
    for t in tags {
        let _ = writeln!(s, "  - {t}");
    }
    if let Some(q) = p["quantized_by"].as_str().filter(|q| !q.is_empty()) {
        let _ = writeln!(s, "quantized_by: {q}");
    }
    let _ = writeln!(s, "---\n");

    let fmt_names: Vec<String> = formats.iter().map(|f| f.to_uppercase()).collect();
    let _ = writeln!(s, "# {name} · {}\n", fmt_names.join(" / "));
    let _ = writeln!(
        s,
        "Quantized versions of [{}]({}) ({} parameters, {}). Produced with iQuantize {} and measured against the original model in the same runtime.\n",
        base.unwrap_or(name),
        base.map(|b| format!("https://huggingface.co/{b}")).unwrap_or_else(|| "#".into()),
        params(&m["parameters"]),
        m["architecture"].as_str().unwrap_or("transformer"),
        p["app"]["version"].as_str().unwrap_or("")
    );

    let _ = writeln!(s, "## Files\n");
    let _ = writeln!(s, "| Format | Variant | Size | Bits/weight | Perplexity | KL divergence | Same top token | Use when |");
    let _ = writeln!(s, "|---|---|---:|---:|---:|---:|---:|---|");
    for r in p["references"].as_array().into_iter().flatten() {
        let _ = writeln!(
            s,
            "| {} | {} (original) | {} | 16 | {} | 0 | 100% | Reference |",
            r["format"].as_str().unwrap_or("").to_uppercase(),
            r["variant"].as_str().unwrap_or(""),
            r["size_bytes"]
                .as_f64()
                .map(human)
                .unwrap_or_else(|| "—".into()),
            num(&r["metrics"]["ppl"], 3)
        );
    }
    for o in &outs {
        let f = o["format"].as_str().unwrap_or("");
        let v = o["variant"].as_str().unwrap_or("");
        let mt = &o["metrics"];
        let _ = writeln!(
            s,
            "| {} | `{v}` | {} | {} | {} | {} | {} | {} |",
            f.to_uppercase(),
            o["size_bytes"]
                .as_f64()
                .map(human)
                .unwrap_or_else(|| "—".into()),
            num(&o["bits_per_weight"], 2),
            num(&mt["ppl"], 3),
            num(&mt["kld_mean"], 4),
            pct(&mt["top1"]),
            use_when(f, v)
        );
    }
    let _ = writeln!(s, "\nLower perplexity and KL divergence are better; \"same top token\" is how often the quantized model's most likely next token matches the original's.\n");

    let _ = writeln!(s, "## How these files were made\n");
    let mut step = 1;
    for f in &formats {
        let fo: Vec<&&Value> = outs.iter().filter(|o| o["format"] == *f).collect();
        match *f {
            "gguf" => {
                let _ = writeln!(s, "{step}. **GGUF (llama.cpp {})**: the original safetensors were converted to a full-precision GGUF with `convert_hf_to_gguf.py`, then quantized with `llama-quantize`.", p["toolchain"]["llama_cpp"].as_str().unwrap_or(""));
                if let Some(im) = fo.iter().find_map(|o| o["imatrix"].as_object()) {
                    let _ = writeln!(s, "   An importance matrix was computed with `llama-imatrix` on {} ({} chunks × {} tokens) so the most important weights keep more precision.", im.get("calibration").and_then(|c| c["description"].as_str()).unwrap_or("calibration text"), im.get("chunks").and_then(|c| c.as_u64()).unwrap_or(0), im.get("ctx").and_then(|c| c.as_u64()).unwrap_or(0));
                }
                if fo
                    .iter()
                    .any(|o| o["fallback_tensors"].as_u64().unwrap_or(0) > 0)
                {
                    let _ = writeln!(s, "   Some tensors have rows that are not a multiple of 256, so llama.cpp stored them with a 32-wide block type; that is why bits per weight are higher than the type names suggest.");
                }
            }
            "mlx" => {
                let _ = writeln!(s, "{step}. **MLX (mlx-lm {})**: weights were quantized with mlx-lm's {} method using group-wise affine or block-floating-point scales.", p["toolchain"]["mlx_lm"].as_str().unwrap_or(""), fo.first().and_then(|o| o["method"].as_str()).unwrap_or("standard"));
            }
            "onnx" => {
                let _ = writeln!(s, "{step}. **ONNX (onnxruntime-genai {})**: the model was exported and weight-only quantized with the ONNX Runtime GenAI model builder (`MatMulNBits`).", p["toolchain"]["onnxruntime_genai"].as_str().unwrap_or(""));
            }
            _ => {}
        }
        step += 1;
    }
    if !p["evaluation"].is_null() {
        let e = &p["evaluation"];
        let _ = writeln!(s, "{step}. **Evaluation**: perplexity and KL divergence were measured on {} ({} chunks × {} tokens) against the original model in the same runtime.", e["dataset"].as_str().unwrap_or("WikiText-2"), e["chunks"], e["tokens_per_chunk"]);
    }
    let _ = writeln!(s);

    let _ = writeln!(s, "## Usage\n");
    for f in &formats {
        match *f {
            "gguf" => {
                let v = outs
                    .iter()
                    .find(|o| o["format"] == "gguf")
                    .and_then(|o| o["variant"].as_str())
                    .unwrap_or("Q4_K_M");
                let _ = writeln!(s, "**llama.cpp**\n\n```bash\nllama-cli -hf {repo}:{v} -p \"Hello\"\n# or serve an OpenAI-compatible API\nllama-server -hf {repo}:{v}\n```\n");
                let _ = writeln!(s, "**Ollama**\n\n```bash\nollama run hf.co/{repo}:{v}\n```\n\n**LM Studio**: search for `{repo}` in the model browser.\n");
            }
            "mlx" => {
                let _ = writeln!(s, "**MLX (Apple Silicon)**\n\n```bash\npip install mlx-lm\nmlx_lm.generate --model {repo} --prompt \"Hello\"\n```\n");
            }
            "onnx" => {
                let _ = writeln!(s, "**ONNX Runtime GenAI**\n\n```python\nimport onnxruntime_genai as og\nmodel = og.Model(\"path/to/downloaded/folder\")\ntokenizer = og.Tokenizer(model)\n```\n");
            }
            _ => {}
        }
    }

    let _ = writeln!(s, "## Hardware used\n");
    let h = &p["hardware"];
    let _ = writeln!(
        s,
        "{} · {} · {} RAM · accelerators: {}.\n",
        h["cpu"].as_str().unwrap_or(""),
        h["os"].as_str().unwrap_or(""),
        h["ram_bytes"].as_f64().map(human).unwrap_or_default(),
        h["accelerators"]
            .as_array()
            .map(|a| a
                .iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(", "))
            .unwrap_or_default()
    );

    let _ = writeln!(s, "## Limitations\n");
    let _ = writeln!(s, "Quantization reduces precision, so outputs can differ from the original model, especially at lower bit widths and on small models. All limitations, biases and license terms of the original model apply.\n");

    let cmds = p["commands"].as_array().cloned().unwrap_or_default();
    if !cmds.is_empty() {
        let _ = writeln!(
            s,
            "## Reproduce\n\n<details><summary>Exact commands</summary>\n\n```bash"
        );
        for c in cmds.iter().filter_map(|c| c.as_str()) {
            let _ = writeln!(s, "{c}");
        }
        let _ = writeln!(s, "```\n\n</details>\n");
    }
    let _ = writeln!(
        s,
        "## License\n\nSame as the original model{}.",
        m["license"]
            .as_str()
            .map(|l| format!(" ({l})"))
            .unwrap_or_default()
    );
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_card_with_front_matter_and_table() {
        let p = json!({
            "app": { "version": "0.1.0" },
            "quantized_by": "me",
            "model": { "name": "Tiny", "repo_id": "org/Tiny", "license": "apache-2.0", "parameters": 135000000, "architecture": "LlamaForCausalLM" },
            "outputs": [{ "format": "gguf", "variant": "Q4_K_M", "size_bytes": 105000000, "bits_per_weight": 6.27, "metrics": { "ppl": 21.42, "kld_mean": 0.0369, "top1": 0.882 }, "imatrix": { "chunks": 32, "ctx": 512, "calibration": { "description": "WikiText-2 (train split)" } }, "fallback_tensors": 180 }],
            "references": [{ "format": "gguf", "variant": "BF16", "size_bytes": 270000000, "metrics": { "ppl": 20.71 } }],
            "toolchain": { "llama_cpp": "b11935" }, "hardware": { "cpu": "M4", "os": "macos", "ram_bytes": 24e9, "accelerators": ["metal"] },
            "evaluation": { "dataset": "WikiText-2 (test split)", "chunks": 20, "tokens_per_chunk": 512 }, "commands": ["llama-quantize a b Q4_K_M"]
        });
        let md = template(&p, Some("me/Tiny-GGUF"));
        assert!(md.starts_with(
            "---\nbase_model: org/Tiny\nbase_model_relation: quantized\nlicense: apache-2.0"
        ));
        assert!(md.contains("| GGUF | `Q4_K_M` | 105.0 MB | 6.27 | 21.420 | 0.0369 | 88.2% |"));
        assert!(md.contains("llama-cli -hf me/Tiny-GGUF:Q4_K_M"));
        assert!(md.contains("imatrix") && md.contains("not a multiple of 256"));
    }
}

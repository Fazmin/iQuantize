//! Hugging Face Hub client (all network calls happen here, never in the WebView).

use crate::error::{http_status_error, AppError, AppResult};
use crate::state::AppState;
use serde_json::{json, Value};

pub const HF: &str = "https://huggingface.co";

fn auth(st: &AppState, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match st.secrets.get(crate::secrets::HF_TOKEN) {
        Ok(Some(tok)) => req.bearer_auth(tok.as_str()),
        _ => req,
    }
}

async fn get_json(st: &AppState, url: &str) -> AppResult<Value> {
    Ok(get_json_page(st, url).await?.0)
}

/// GETs JSON plus the cursor for the next page, which the Hub sends in a
/// `Link: <…&cursor=…>; rel="next"` header on list endpoints.
async fn get_json_page(st: &AppState, url: &str) -> AppResult<(Value, Option<String>)> {
    let resp = auth(st, st.http.get(url))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(http_status_error("Hugging Face", status, &body));
    }
    let next = resp
        .headers()
        .get(reqwest::header::LINK)
        .and_then(|v| v.to_str().ok())
        .and_then(next_cursor);
    Ok((resp.json().await?, next))
}

/// Extracts the `cursor` query value from the `rel="next"` entry of a Link header.
fn next_cursor(link: &str) -> Option<String> {
    let entry = link.split(',').find(|e| e.contains("rel=\"next\""))?;
    let target = entry.split(';').next()?.trim();
    let url = reqwest::Url::parse(target.trim_start_matches('<').trim_end_matches('>')).ok()?;
    url.query_pairs()
        .find(|(k, _)| k == "cursor")
        .map(|(_, v)| v.into_owned())
}

pub fn valid_repo_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('/').collect();
    (parts.len() == 2 || parts.len() == 1)
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.len() <= 96
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
                && !p.starts_with('.')
        })
}

pub async fn whoami(st: &AppState) -> AppResult<Value> {
    let tok = st
        .secrets
        .require(crate::secrets::HF_TOKEN, "Hugging Face token")?;
    let resp = st
        .http
        .get(format!("{HF}/api/whoami-v2"))
        .bearer_auth(tok.as_str())
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(http_status_error("Hugging Face", status, &body));
    }
    let v: Value = resp.json().await?;
    let role = v["auth"]["accessToken"]["role"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let orgs: Vec<String> = v["orgs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|o| o["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let name = v["name"].as_str().unwrap_or_default().to_string();
    let _ = st.db.set_setting("hf_username", &name);
    Ok(json!({
        "name": name,
        "fullname": v["fullname"],
        "avatar": v["avatarUrl"],
        "role": role,
        "can_write": role == "write" || role == "fineGrained" || role == "admin",
        "orgs": orgs,
    }))
}

/// One page of text-generation models. Returns `{ items, cursor }`; pass `cursor` back
/// to get the next page with the same query and sort.
pub async fn search(
    st: &AppState,
    query: &str,
    sort: &str,
    limit: u32,
    cursor: Option<&str>,
) -> AppResult<Value> {
    let sort = match sort {
        "likes" | "lastModified" | "trendingScore" | "downloads" => sort,
        _ => "downloads",
    };
    let mut url = reqwest::Url::parse(&format!("{HF}/api/models"))
        .map_err(|e| AppError::invalid(e.to_string()))?;
    {
        let mut q = url.query_pairs_mut();
        if !query.trim().is_empty() {
            q.append_pair("search", query.trim());
        }
        q.append_pair("pipeline_tag", "text-generation");
        q.append_pair("sort", sort);
        q.append_pair("direction", "-1");
        q.append_pair("limit", &limit.clamp(1, 100).to_string());
        for e in [
            "downloads",
            "likes",
            "gated",
            "lastModified",
            "safetensors",
            "tags",
            "library_name",
            "pipeline_tag",
        ] {
            q.append_pair("expand[]", e);
        }
        if let Some(c) = cursor.filter(|c| !c.is_empty()) {
            q.append_pair("cursor", c);
        }
    }
    let (v, next) = get_json_page(st, url.as_str()).await?;
    let items: Vec<Value> = v
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let tags: Vec<String> = m["tags"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|t| t.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            // Originals often ship extra GGUF/ONNX exports, so only trust strong signals.
            let lib = m["library_name"].as_str().unwrap_or("");
            let quantized = lib == "gguf"
                || lib == "mlx"
                || tags.iter().any(|t| {
                    [
                        "awq",
                        "gptq",
                        "4-bit",
                        "8-bit",
                        "fp8",
                        "exl2",
                        "bitsandbytes",
                        "compressed-tensors",
                    ]
                    .contains(&t.as_str())
                });
            json!({
                "id": m["id"],
                "downloads": m["downloads"],
                "likes": m["likes"],
                "gated": m["gated"],
                "last_modified": m["lastModified"],
                "params": m["safetensors"]["total"],
                "library": m["library_name"],
                "license": tags.iter().find_map(|t| t.strip_prefix("license:")),
                "already_quantized": quantized,
                "has_safetensors": m["safetensors"].is_object(),
            })
        })
        .collect();
    Ok(json!({ "items": items, "cursor": next }))
}

/// Detailed info for a repo at a revision: files, sizes, config analysis, compatibility.
pub async fn model_info(st: &AppState, repo: &str, revision: Option<&str>) -> AppResult<Value> {
    if !valid_repo_id(repo) {
        return Err(AppError::invalid(format!(
            "\"{repo}\" is not a valid Hugging Face model id (owner/name)"
        )));
    }
    let rev = revision.unwrap_or("main");
    let info = get_json(
        st,
        &format!("{HF}/api/models/{repo}/revision/{rev}?blobs=true"),
    )
    .await?;
    let sha = info["sha"].as_str().unwrap_or(rev).to_string();
    let config: Value = match auth(
        st,
        st.http
            .get(format!("{HF}/{repo}/resolve/{sha}/config.json")),
    )
    .send()
    .await
    {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let arch = crate::models::config::analyze(&config);
    let siblings: Vec<Value> = info["siblings"].as_array().cloned().unwrap_or_default();
    let files: Vec<Value> = siblings
        .iter()
        .map(|s| {
            json!({
                "path": s["rfilename"],
                "size": s["size"].as_u64().or_else(|| s["lfs"]["size"].as_u64()),
                "sha256": s["lfs"]["sha256"],
            })
        })
        .collect();
    let selected = crate::models::select_files(&files);
    let download_bytes: u64 = selected.iter().filter_map(|f| f["size"].as_u64()).sum();
    let params = info["safetensors"]["total"]
        .as_u64()
        .or_else(|| crate::models::config::estimate_params(&arch));
    let license = info["cardData"]["license"]
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            info["tags"].as_array().and_then(|t| {
                t.iter()
                    .filter_map(|x| x.as_str())
                    .find_map(|x| x.strip_prefix("license:").map(str::to_string))
            })
        });
    let has_safetensors = files.iter().any(|f| {
        f["path"]
            .as_str()
            .map(|p| p.ends_with(".safetensors"))
            .unwrap_or(false)
    });
    Ok(json!({
        "repo_id": repo,
        "revision": sha,
        "gated": info["gated"],
        "private": info["private"],
        "license": license,
        "license_name": info["cardData"]["license_name"],
        "base_model": info["cardData"]["base_model"],
        "downloads": info["downloads"],
        "likes": info["likes"],
        "last_modified": info["lastModified"],
        "tags": info["tags"],
        "params": params,
        "params_by_dtype": info["safetensors"]["parameters"],
        "arch": arch,
        "config": config,
        "files": files,
        "download_files": selected,
        "download_bytes": download_bytes,
        "has_safetensors": has_safetensors,
        "compat": crate::models::compat(st, arch.architecture.as_deref(), arch.model_type.as_deref(), has_safetensors, arch.quantization.as_deref()),
        "library": info["library_name"],
        "chat_template": config.is_object() && siblings.iter().any(|s| s["rfilename"].as_str().map(|n| n == "tokenizer_config.json" || n.ends_with(".jinja")).unwrap_or(false)),
    }))
}

/// Checks whether a repo exists and whether the user can write to it.
pub async fn repo_status(st: &AppState, repo: &str) -> AppResult<Value> {
    if !valid_repo_id(repo) || !repo.contains('/') {
        return Err(AppError::invalid("Use the form owner/name"));
    }
    let resp = auth(st, st.http.get(format!("{HF}/api/models/{repo}")))
        .send()
        .await?;
    match resp.status().as_u16() {
        200 => {
            let v: Value = resp.json().await?;
            Ok(
                json!({ "exists": true, "private": v["private"], "sha": v["sha"], "files": v["siblings"].as_array().map(|a| a.len()).unwrap_or(0) }),
            )
        }
        401 | 404 => Ok(json!({ "exists": false })),
        s => {
            let body = resp.text().await.unwrap_or_default();
            Err(http_status_error(
                "Hugging Face",
                reqwest::StatusCode::from_u16(s).unwrap_or_default(),
                &body,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_repo_ids() {
        assert!(valid_repo_id("HuggingFaceTB/SmolLM2-135M-Instruct"));
        assert!(valid_repo_id("gpt2"));
        assert!(!valid_repo_id("a/b/c"));
        assert!(!valid_repo_id("../etc"));
        assert!(!valid_repo_id("user/na me"));
    }

    #[test]
    fn reads_next_cursor_from_link_header() {
        let link = r#"<https://huggingface.co/api/models?search=qwen&limit=2&cursor=eyJhIjoxfQ%3D%3D>; rel="next""#;
        assert_eq!(next_cursor(link).as_deref(), Some("eyJhIjoxfQ=="));
        let both = r#"<https://huggingface.co/api/models?cursor=prev>; rel="prev", <https://huggingface.co/api/models?cursor=nxt>; rel="next""#;
        assert_eq!(next_cursor(both).as_deref(), Some("nxt"));
        assert_eq!(next_cursor(r#"<https://huggingface.co/api/models?cursor=p>; rel="prev""#), None);
        assert_eq!(next_cursor(""), None);
    }
}

//! OpenAI (or compatible) client for documentation help, using the Responses API with
//! streaming. Featured models are reconciled against the key's live `/v1/models` list.

use crate::db::now_ms;
use crate::error::{http_status_error, AppError, AppResult};
use crate::secrets::OPENAI_KEY;
use crate::state::AppState;
use futures_util::StreamExt;
use serde_json::{json, Value};

fn base_url(st: &AppState) -> String {
    st.setting_or("ai_base_url", "https://api.openai.com/v1")
        .trim_end_matches('/')
        .to_string()
}

pub async fn models(st: &AppState, refresh: bool) -> AppResult<Value> {
    let mut live: Vec<String> = vec![];
    if refresh {
        let key = st.secrets.require(OPENAI_KEY, "OpenAI API key")?;
        let resp = st
            .http
            .get(format!("{}/models", base_url(st)))
            .bearer_auth(key.as_str())
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await?;
        if !resp.status().is_success() {
            let s = resp.status();
            let b = resp.text().await.unwrap_or_default();
            return Err(http_status_error("OpenAI", s, &b));
        }
        let v: Value = resp.json().await?;
        live = v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["id"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        live.sort();
        let ts = now_ms();
        st.db.tx(|tx| {
            let ids: Vec<String> = {
                let mut s = tx.prepare("SELECT id FROM ai_models")?;
                let r = s.query_map([], |r| r.get::<_, String>(0))?;
                r.collect::<Result<_, _>>()?
            };
            for id in ids {
                // gpt-5.6 is documented as an alias of gpt-5.6-sol; accept either form.
                let ok = live
                    .iter()
                    .any(|l| l == &id || l.starts_with(&format!("{id}-20")));
                tx.execute(
                    "UPDATE ai_models SET available = ?1, checked_at = ?2 WHERE id = ?3",
                    rusqlite::params![ok as i64, ts, id],
                )?;
            }
            Ok(())
        })?;
    }
    let featured: Vec<Value> = st.db.with(|c| {
        let mut s = c.prepare("SELECT id, family, label, price_in, price_out, notes, available, checked_at FROM ai_models WHERE featured = 1 ORDER BY sort")?;
        let r = s.query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "family": r.get::<_, String>(1)?, "label": r.get::<_, String>(2)?,
                "price_in": r.get::<_, Option<f64>>(3)?, "price_out": r.get::<_, Option<f64>>(4)?, "notes": r.get::<_, Option<String>>(5)?,
                "available": r.get::<_, Option<i64>>(6)?.map(|v| v != 0), "checked_at": r.get::<_, Option<i64>>(7)?,
            }))
        })?;
        r.collect()
    })?;
    let gpt_live: Vec<&String> = live
        .iter()
        .filter(|m| m.starts_with("gpt-") || m.starts_with('o'))
        .collect();
    Ok(
        json!({ "featured": featured, "live": gpt_live, "live_count": live.len(), "base_url": base_url(st) }),
    )
}

pub fn instructions(action: &str) -> String {
    let base = "You are a meticulous technical writer creating a Hugging Face model card (README.md) for quantized LLM weights. \
Ground every statement in the PROVENANCE JSON you are given. Never invent numbers, benchmark scores, speeds, dates or claims: \
if a number is not in the provenance or the template, do not write it. Keep the YAML front matter exactly as in the template unless asked. \
Write clear, friendly English for practitioners who may be new to quantization. Use GitHub-flavored Markdown. Output only Markdown, no preamble.";
    let task = match action {
        "draft" => "Write the complete model card. Start from the TEMPLATE, keep its YAML front matter and tables, improve the prose, add a short 'Which file should I pick?' section derived from the table, and explain the quantization process step by step.",
        "beginner" => "Write a section titled '## How this model was quantized, in plain English' (150–300 words) that explains, for a newcomer, what was done to this model and what the measurements mean, using only the provenance. Output only that section.",
        "rewrite" => "Rewrite the SELECTION to be clearer and more accurate. Keep the same meaning, headings and facts. Output only the rewritten text.",
        "tighten" => "Make the SELECTION about 40% shorter without losing facts. Output only the shortened text.",
        "expand" => "Expand the SELECTION with more helpful explanation grounded in the provenance. Output only the expanded text.",
        "faq" => "Write a '## FAQ' section with 5–7 practical questions and answers (which file to pick, memory needs, how quality was measured, how to run it, license). Output only that section.",
        "changelog" => "Write a short '## Changelog' entry summarizing what was produced and with which tools. Output only that section.",
        _ => "Improve the document.",
    };
    format!("{base}\n\nTASK: {task}")
}

/// Streams a Responses API call; emits `ai:delta`, `ai:done`, `ai:error` for `stream`.
#[allow(clippy::too_many_arguments)]
pub async fn generate(
    st: &AppState,
    stream: &str,
    model: &str,
    effort: Option<&str>,
    action: &str,
    input: &str,
    document_id: Option<&str>,
    cancel: tokio_util::sync::CancellationToken,
) -> AppResult<String> {
    let key = st.secrets.require(OPENAI_KEY, "OpenAI API key")?;
    let mut body = json!({ "model": model, "instructions": instructions(action), "input": input, "stream": true, "max_output_tokens": 12000 });
    if let Some(e) = effort.filter(|e| !e.is_empty()) {
        body["reasoning"] = json!({ "effort": e });
    }
    let send = |b: &Value| {
        st.http
            .post(format!("{}/responses", base_url(st)))
            .bearer_auth(key.as_str())
            .json(b)
            .send()
    };
    let mut resp = send(&body).await?;
    if resp.status().as_u16() == 400 && body.get("reasoning").is_some() {
        // Some models don't accept reasoning settings; retry once without.
        let text = resp.text().await.unwrap_or_default();
        if text.contains("reasoning") {
            body.as_object_mut().map(|o| o.remove("reasoning"));
            resp = send(&body).await?;
        } else {
            return Err(http_status_error(
                "OpenAI",
                reqwest::StatusCode::BAD_REQUEST,
                &text,
            ));
        }
    }
    if !resp.status().is_success() {
        let s = resp.status();
        let b = resp.text().await.unwrap_or_default();
        return Err(http_status_error("OpenAI", s, &b));
    }
    let mut out = String::new();
    let mut buf = String::new();
    let mut usage = Value::Null;
    let mut bytes = resp.bytes_stream();
    loop {
        let chunk = tokio::select! {
            c = bytes.next() => c,
            _ = cancel.cancelled() => return Err(AppError::cancelled()),
        };
        let Some(chunk) = chunk else { break };
        buf.push_str(&String::from_utf8_lossy(&chunk?));
        while let Some(i) = buf.find('\n') {
            let line = buf[..i].trim().to_string();
            buf.drain(..=i);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(data.trim()) else {
                continue;
            };
            match v["type"].as_str() {
                Some("response.output_text.delta") => {
                    if let Some(d) = v["delta"].as_str() {
                        out.push_str(d);
                        st.hub
                            .emit("ai:delta", json!({ "stream": stream, "text": d }));
                    }
                }
                Some("response.completed") => usage = v["response"]["usage"].clone(),
                Some("response.failed") | Some("error") => {
                    let msg = v["response"]["error"]["message"]
                        .as_str()
                        .or(v["message"].as_str())
                        .or(v["error"]["message"].as_str())
                        .unwrap_or("The model returned an error");
                    return Err(AppError::new("openai", msg.to_string()));
                }
                _ => {}
            }
        }
    }
    let (inp, outp) = (
        usage["input_tokens"].as_i64().unwrap_or(0),
        usage["output_tokens"].as_i64().unwrap_or(0),
    );
    let reasoning = usage["output_tokens_details"]["reasoning_tokens"].as_i64();
    let prices: Option<(Option<f64>, Option<f64>)> = st
        .db
        .with(|c| {
            rusqlite::OptionalExtension::optional(c.query_row(
                "SELECT price_in, price_out FROM ai_models WHERE id = ?1",
                [model],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ))
        })
        .ok()
        .flatten();
    let cost = prices.and_then(|(pi, po)| Some((inp as f64 * pi? + outp as f64 * po?) / 1e6));
    let _ = st.db.with(|c| {
        c.execute(
            "INSERT INTO ai_usage (model, action, document_id, input_tokens, output_tokens, reasoning_tokens, cost_estimate, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![model, action, document_id, inp, outp, reasoning, cost, now_ms()],
        )
    });
    st.hub.emit(
        "ai:done",
        json!({ "stream": stream, "usage": usage, "cost": cost, "chars": out.len() }),
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn instructions_forbid_invented_numbers() {
        let s = super::instructions("draft");
        assert!(s.contains("Never invent numbers") && s.contains("TASK"));
    }
}

//! Header-only readers for safetensors and GGUF files: tensor names, shapes, dtypes, sizes.
//! Used for the tensor map, the estimator and per-tensor results after quantization.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct TensorInfo {
    pub name: String,
    pub shape: Vec<u64>,
    pub dtype: String,
    pub n_elements: u64,
    pub bytes: u64,
    /// Effective bits per weight for this tensor (bytes*8/elements).
    pub bits: f64,
}

pub fn safetensors_dtype_bytes(dtype: &str) -> f64 {
    match dtype {
        "F64" | "I64" | "U64" => 8.0,
        "F32" | "I32" | "U32" => 4.0,
        "F16" | "BF16" | "I16" | "U16" => 2.0,
        "F8_E4M3" | "F8_E5M2" | "I8" | "U8" | "BOOL" | "F8_E8M0" => 1.0,
        "F4" | "F6_E2M3" | "F6_E3M2" => 0.5,
        _ => 2.0,
    }
}

/// Reads the JSON header of a .safetensors file.
pub fn read_safetensors(path: &Path) -> AppResult<Vec<TensorInfo>> {
    let mut f = std::fs::File::open(path)?;
    let mut len = [0u8; 8];
    f.read_exact(&mut len)?;
    let n = u64::from_le_bytes(len);
    if n > 200_000_000 {
        return Err(AppError::invalid(format!(
            "{} does not look like a safetensors file",
            path.display()
        )));
    }
    let mut buf = vec![0u8; n as usize];
    f.read_exact(&mut buf)?;
    parse_safetensors_header(&buf)
}

pub fn parse_safetensors_header(buf: &[u8]) -> AppResult<Vec<TensorInfo>> {
    let v: serde_json::Value = serde_json::from_slice(buf)?;
    let obj = v
        .as_object()
        .ok_or_else(|| AppError::invalid("Bad safetensors header"))?;
    let mut out = vec![];
    for (name, t) in obj {
        if name == "__metadata__" {
            continue;
        }
        let dtype = t["dtype"].as_str().unwrap_or("F16").to_string();
        let shape: Vec<u64> = t["shape"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
            .unwrap_or_default();
        let n_elements: u64 =
            shape
                .iter()
                .product::<u64>()
                .max(if shape.is_empty() { 1 } else { 0 });
        let bytes = t["data_offsets"]
            .as_array()
            .and_then(|o| Some(o.get(1)?.as_u64()? - o.first()?.as_u64()?))
            .unwrap_or((n_elements as f64 * safetensors_dtype_bytes(&dtype)) as u64);
        out.push(TensorInfo {
            bits: if n_elements > 0 {
                bytes as f64 * 8.0 / n_elements as f64
            } else {
                0.0
            },
            name: name.clone(),
            shape,
            dtype,
            n_elements,
            bytes,
        });
    }
    Ok(out)
}

/// All tensors of a model directory (every *.safetensors file).
pub fn read_safetensors_dir(dir: &Path) -> AppResult<Vec<TensorInfo>> {
    let mut files: Vec<_> = std::fs::read_dir(dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "safetensors").unwrap_or(false))
        .collect();
    files.sort();
    let mut out = vec![];
    for f in files {
        out.extend(read_safetensors(&f)?);
    }
    Ok(out)
}

/* ---------------- GGUF ---------------- */

/// ggml type id → (name, block size, bytes per block).
pub fn ggml_type(id: u32) -> (&'static str, u64, u64) {
    match id {
        0 => ("F32", 1, 4),
        1 => ("F16", 1, 2),
        2 => ("Q4_0", 32, 18),
        3 => ("Q4_1", 32, 20),
        6 => ("Q5_0", 32, 22),
        7 => ("Q5_1", 32, 24),
        8 => ("Q8_0", 32, 34),
        9 => ("Q8_1", 32, 36),
        10 => ("Q2_K", 256, 84),
        11 => ("Q3_K", 256, 110),
        12 => ("Q4_K", 256, 144),
        13 => ("Q5_K", 256, 176),
        14 => ("Q6_K", 256, 210),
        15 => ("Q8_K", 256, 292),
        16 => ("IQ2_XXS", 256, 66),
        17 => ("IQ2_XS", 256, 74),
        18 => ("IQ3_XXS", 256, 98),
        19 => ("IQ1_S", 256, 50),
        20 => ("IQ4_NL", 32, 18),
        21 => ("IQ3_S", 256, 110),
        22 => ("IQ2_S", 256, 82),
        23 => ("IQ4_XS", 256, 136),
        24 => ("I8", 1, 1),
        25 => ("I16", 1, 2),
        26 => ("I32", 1, 4),
        27 => ("I64", 1, 8),
        28 => ("F64", 1, 8),
        29 => ("IQ1_M", 256, 56),
        30 => ("BF16", 1, 2),
        34 => ("TQ1_0", 256, 54),
        35 => ("TQ2_0", 256, 66),
        39 => ("MXFP4", 32, 17),
        _ => ("", 0, 0),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GgufFile {
    pub version: u32,
    pub metadata: BTreeMap<String, serde_json::Value>,
    pub tensors: Vec<TensorInfo>,
    pub file_size: u64,
}

struct R<T: Read> {
    r: T,
}

impl<T: Read> R<T> {
    fn u8(&mut self) -> std::io::Result<u8> {
        let mut b = [0u8; 1];
        self.r.read_exact(&mut b)?;
        Ok(b[0])
    }
    fn u32(&mut self) -> std::io::Result<u32> {
        let mut b = [0u8; 4];
        self.r.read_exact(&mut b)?;
        Ok(u32::from_le_bytes(b))
    }
    fn u64(&mut self) -> std::io::Result<u64> {
        let mut b = [0u8; 8];
        self.r.read_exact(&mut b)?;
        Ok(u64::from_le_bytes(b))
    }
    fn string(&mut self) -> std::io::Result<String> {
        let n = self.u64()?;
        if n > 64 * 1024 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "string too long",
            ));
        }
        let mut b = vec![0u8; n as usize];
        self.r.read_exact(&mut b)?;
        Ok(String::from_utf8_lossy(&b).into_owned())
    }
    fn skip(&mut self, n: u64) -> std::io::Result<()> {
        std::io::copy(&mut (&mut self.r).take(n), &mut std::io::sink())?;
        Ok(())
    }
    /// Reads a metadata value; arrays longer than 64 entries are summarized, not kept.
    fn value(&mut self, ty: u32) -> std::io::Result<serde_json::Value> {
        use serde_json::json;
        Ok(match ty {
            0 => json!(self.u8()?),
            1 => json!(self.u8()? as i8),
            2 => {
                let mut b = [0u8; 2];
                self.r.read_exact(&mut b)?;
                json!(u16::from_le_bytes(b))
            }
            3 => {
                let mut b = [0u8; 2];
                self.r.read_exact(&mut b)?;
                json!(i16::from_le_bytes(b))
            }
            4 => json!(self.u32()?),
            5 => json!(self.u32()? as i32),
            6 => json!(f32::from_bits(self.u32()?)),
            7 => json!(self.u8()? != 0),
            8 => json!(self.string()?),
            9 => {
                let et = self.u32()?;
                let n = self.u64()?;
                let fixed = match et {
                    0 | 1 | 7 => Some(1),
                    2 | 3 => Some(2),
                    4..=6 => Some(4),
                    10..=12 => Some(8),
                    _ => None,
                };
                if n > 64 {
                    match fixed {
                        Some(sz) => self.skip(n * sz)?,
                        None => {
                            for _ in 0..n {
                                self.value(et)?;
                            }
                        }
                    }
                    json!({ "array_len": n })
                } else {
                    let mut items = vec![];
                    for _ in 0..n {
                        items.push(self.value(et)?);
                    }
                    serde_json::Value::Array(items)
                }
            }
            10 => json!(self.u64()?),
            11 => json!(self.u64()? as i64),
            12 => {
                let v = self.u64()?;
                json!(f64::from_bits(v))
            }
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unknown GGUF value type {ty}"),
                ))
            }
        })
    }
}

/// Parses the header of a GGUF file (metadata + tensor table) without reading tensor data.
pub fn read_gguf(path: &Path) -> AppResult<GgufFile> {
    let file = std::fs::File::open(path)?;
    let file_size = file.metadata()?.len();
    let mut br = BufReader::with_capacity(1 << 20, file);
    let mut r = R { r: &mut br };
    let mut magic = [0u8; 4];
    r.r.read_exact(&mut magic)?;
    if &magic != b"GGUF" {
        return Err(AppError::invalid(format!(
            "{} is not a GGUF file",
            path.display()
        )));
    }
    let version = r.u32()?;
    let n_tensors = r.u64()?;
    let n_kv = r.u64()?;
    let mut metadata = BTreeMap::new();
    for _ in 0..n_kv {
        let key = r.string()?;
        let ty = r.u32()?;
        let v = r.value(ty)?;
        metadata.insert(key, v);
    }
    let mut raw = vec![];
    for _ in 0..n_tensors {
        let name = r.string()?;
        let nd = r.u32()?;
        let mut shape = vec![];
        for _ in 0..nd {
            shape.push(r.u64()?);
        }
        let ty = r.u32()?;
        let offset = r.u64()?;
        raw.push((name, shape, ty, offset));
    }
    let header_end = br.stream_position()?;
    let align = metadata
        .get("general.alignment")
        .and_then(|v| v.as_u64())
        .unwrap_or(32);
    let data_start = header_end.div_ceil(align) * align;
    // Sizes from offset gaps work for every type, including ones newer than our table.
    let mut order: Vec<usize> = (0..raw.len()).collect();
    order.sort_by_key(|&i| raw[i].3);
    let mut sizes = vec![0u64; raw.len()];
    for (k, &i) in order.iter().enumerate() {
        let next = order
            .get(k + 1)
            .map(|&j| raw[j].3)
            .unwrap_or(file_size.saturating_sub(data_start));
        sizes[i] = next.saturating_sub(raw[i].3);
    }
    let tensors = raw
        .into_iter()
        .enumerate()
        .map(|(i, (name, shape, ty, _))| {
            let n: u64 = shape.iter().product::<u64>().max(1);
            let (tn, bs, ts) = ggml_type(ty);
            // Prefer the exact size from the type table; offset gaps include alignment padding.
            let exact = n
                .checked_div(bs)
                .map(|blocks| blocks * ts)
                .unwrap_or(sizes[i]);
            let bytes = if exact > 0 { exact } else { sizes[i] };
            TensorInfo {
                name,
                bits: bytes as f64 * 8.0 / n as f64,
                dtype: if tn.is_empty() {
                    format!("type{ty}")
                } else {
                    tn.to_string()
                },
                shape,
                n_elements: n,
                bytes,
            }
        })
        .collect();
    let _ = br.seek(SeekFrom::Start(0));
    Ok(GgufFile {
        version,
        metadata,
        tensors,
        file_size,
    })
}

/// Sum of parameters and bytes, plus bytes per dtype.
pub fn summarize(tensors: &[TensorInfo]) -> serde_json::Value {
    let mut by_dtype: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let (mut params, mut bytes) = (0u64, 0u64);
    for t in tensors {
        params += t.n_elements;
        bytes += t.bytes;
        let e = by_dtype.entry(t.dtype.clone()).or_default();
        e.0 += t.n_elements;
        e.1 += t.bytes;
    }
    serde_json::json!({
        "params": params,
        "bytes": bytes,
        "bpw": if params > 0 { bytes as f64 * 8.0 / params as f64 } else { 0.0 },
        "tensors": tensors.len(),
        "by_dtype": by_dtype.into_iter().map(|(k, (p, b))| serde_json::json!({ "dtype": k, "params": p, "bytes": b, "bits": if p > 0 { b as f64 * 8.0 / p as f64 } else { 0.0 } })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_gguf(path: &Path) {
        use std::io::Write;
        let mut b: Vec<u8> = vec![];
        b.extend(b"GGUF");
        b.extend(3u32.to_le_bytes());
        b.extend(2u64.to_le_bytes()); // tensors
        b.extend(2u64.to_le_bytes()); // kv
        let s = |b: &mut Vec<u8>, v: &str| {
            b.extend((v.len() as u64).to_le_bytes());
            b.extend(v.as_bytes());
        };
        s(&mut b, "general.architecture");
        b.extend(8u32.to_le_bytes());
        s(&mut b, "llama");
        s(&mut b, "llama.block_count");
        b.extend(4u32.to_le_bytes());
        b.extend(1u32.to_le_bytes());
        // tensor 0: Q4_K 256x2 at offset 0 (2 blocks * 144 bytes = 288)
        s(&mut b, "blk.0.attn_q.weight");
        b.extend(2u32.to_le_bytes());
        b.extend(256u64.to_le_bytes());
        b.extend(2u64.to_le_bytes());
        b.extend(12u32.to_le_bytes());
        b.extend(0u64.to_le_bytes());
        // tensor 1: F32 norm of 256 at offset 288
        s(&mut b, "blk.0.attn_norm.weight");
        b.extend(1u32.to_le_bytes());
        b.extend(256u64.to_le_bytes());
        b.extend(0u32.to_le_bytes());
        b.extend(288u64.to_le_bytes());
        while b.len() % 32 != 0 {
            b.push(0);
        }
        b.extend(vec![0u8; 288 + 1024]);
        std::fs::File::create(path).unwrap().write_all(&b).unwrap();
    }

    #[test]
    fn parses_gguf_header_and_sizes() {
        let p = std::env::temp_dir().join(format!("iq-{}.gguf", crate::db::new_id()));
        write_gguf(&p);
        let g = read_gguf(&p).unwrap();
        assert_eq!(g.metadata["general.architecture"], "llama");
        assert_eq!(g.tensors.len(), 2);
        assert_eq!(g.tensors[0].dtype, "Q4_K");
        assert_eq!(g.tensors[0].bytes, 288);
        assert!((g.tensors[0].bits - 4.5).abs() < 1e-9);
        assert_eq!(g.tensors[1].bytes, 1024);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn parses_safetensors_header() {
        let h = br#"{"__metadata__":{"format":"pt"},"model.embed_tokens.weight":{"dtype":"BF16","shape":[100,64],"data_offsets":[0,12800]}}"#;
        let t = parse_safetensors_header(h).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].n_elements, 6400);
        assert_eq!(t[0].bytes, 12800);
        assert!((t[0].bits - 16.0).abs() < 1e-9);
    }
}

//! Recipe types: everything a user can choose in the wizard, per format. Stored with each
//! job (for provenance) and as reusable presets.

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}
fn d_chunks() -> u32 {
    128
}
fn d_ctx() -> u32 {
    512
}
fn d_eval_chunks() -> u32 {
    40
}
fn d_gs() -> u32 {
    64
}
fn d_bits() -> u32 {
    4
}
fn d_mode() -> String {
    "affine".into()
}
fn d_block() -> u32 {
    32
}
fn d_precision() -> String {
    "int4".into()
}
fn d_ep() -> String {
    "cpu".into()
}
fn d_acc() -> u32 {
    4
}
fn d_algo() -> String {
    "k_quant".into()
}
fn d_base() -> String {
    "auto".into()
}
fn d_split() -> f64 {
    48.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibSpec {
    /// preset id (wikitext2-train, pile-val, c4-en), "file", or "hf"
    pub source: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub dataset: Option<String>,
    #[serde(default)]
    pub config: Option<String>,
    #[serde(default)]
    pub split: Option<String>,
    #[serde(default)]
    pub column: Option<String>,
}

impl Default for CalibSpec {
    fn default() -> Self {
        Self {
            source: "wikitext2-train".into(),
            path: None,
            dataset: None,
            config: None,
            split: None,
            column: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalSpec {
    #[serde(default = "default_true")]
    pub ppl: bool,
    #[serde(default = "default_true")]
    pub kld: bool,
    #[serde(default)]
    pub speed: bool,
    #[serde(default = "d_eval_chunks")]
    pub chunks: u32,
    #[serde(default = "d_ctx")]
    pub ctx: u32,
}

impl Default for EvalSpec {
    fn default() -> Self {
        Self {
            ppl: true,
            kld: true,
            speed: false,
            chunks: d_eval_chunks(),
            ctx: d_ctx(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TensorTypeRule {
    pub pattern: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImatrixSpec {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "d_chunks")]
    pub chunks: u32,
    #[serde(default = "d_ctx")]
    pub ctx: u32,
}

impl Default for ImatrixSpec {
    fn default() -> Self {
        Self {
            enabled: false,
            chunks: d_chunks(),
            ctx: d_ctx(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GgufRecipe {
    /// Intermediate precision from convert_hf_to_gguf.py: auto | bf16 | f16 | f32 | q8_0
    #[serde(default = "d_base")]
    pub base: String,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default)]
    pub imatrix: ImatrixSpec,
    #[serde(default)]
    pub output_tensor_type: Option<String>,
    #[serde(default)]
    pub token_embedding_type: Option<String>,
    #[serde(default)]
    pub leave_output_tensor: bool,
    #[serde(default)]
    pub pure: bool,
    #[serde(default)]
    pub tensor_types: Vec<TensorTypeRule>,
    #[serde(default)]
    pub keep_split: bool,
    #[serde(default = "d_split")]
    pub split_max_size_gb: f64,
    #[serde(default)]
    pub use_temp_file: bool,
}

impl Default for GgufRecipe {
    fn default() -> Self {
        Self {
            base: d_base(),
            types: vec!["Q4_K_M".into()],
            imatrix: ImatrixSpec::default(),
            output_tensor_type: None,
            token_embedding_type: None,
            leave_output_tensor: false,
            pure: false,
            tensor_types: vec![],
            keep_split: false,
            split_max_size_gb: d_split(),
            use_temp_file: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MlxVariant {
    #[serde(default = "d_bits")]
    pub bits: u32,
    #[serde(default = "d_gs")]
    pub group_size: u32,
    #[serde(default = "d_mode")]
    pub mode: String,
    #[serde(default)]
    pub recipe: Option<String>,
    #[serde(default)]
    pub dtype: Option<String>,
}

impl MlxVariant {
    pub fn label(&self) -> String {
        let mut s = match self.mode.as_str() {
            "affine" => format!("{}bit-gs{}", self.bits, self.group_size),
            m => m.to_string(),
        };
        if let Some(r) = &self.recipe {
            s = format!("{r}-gs{}", self.group_size);
        }
        s
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MlxRule {
    pub pattern: String,
    /// 0 = keep in full precision
    #[serde(default)]
    pub bits: u32,
    #[serde(default)]
    pub group_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MlxRecipe {
    /// convert | awq | gptq | dwq | dynamic_quant
    #[serde(default = "convert")]
    pub method: String,
    pub variants: Vec<MlxVariant>,
    #[serde(default)]
    pub rules: Vec<MlxRule>,
    #[serde(default)]
    pub trust_remote_code: bool,
    #[serde(default)]
    pub num_samples: Option<u32>,
    #[serde(default)]
    pub sequence_length: Option<u32>,
    #[serde(default)]
    pub target_bpw: Option<f64>,
}

fn convert() -> String {
    "convert".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnnxVariant {
    #[serde(default = "d_precision")]
    pub precision: String,
    #[serde(default = "d_ep")]
    pub ep: String,
    #[serde(default = "d_block")]
    pub block_size: u32,
    #[serde(default = "d_acc")]
    pub accuracy_level: u32,
    #[serde(default = "d_algo")]
    pub algo: String,
    #[serde(default = "default_true")]
    pub is_symmetric: bool,
    /// Keep the LM head at INT8 via matmul_mixed_precision=last_matmul:int8.
    #[serde(default)]
    pub head_int8: bool,
}

impl Default for OnnxVariant {
    fn default() -> Self {
        Self {
            precision: d_precision(),
            ep: d_ep(),
            block_size: d_block(),
            accuracy_level: d_acc(),
            algo: d_algo(),
            is_symmetric: true,
            head_int8: false,
        }
    }
}

impl OnnxVariant {
    pub fn label(&self) -> String {
        let mut s = format!("{}-{}", self.precision, self.ep);
        if self.precision == "int4" {
            s.push_str(&format!("-b{}", self.block_size));
            if self.algo != "default" {
                s.push_str(&format!("-{}", self.algo));
            }
            if self.head_int8 {
                s.push_str("-head8");
            }
        }
        s
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnnxRecipe {
    /// builder | optimum
    #[serde(default = "builder")]
    pub engine: String,
    pub variants: Vec<OnnxVariant>,
    /// Engine B only: int8_dynamic | int4_weight
    #[serde(default)]
    pub optimum_mode: Option<String>,
    #[serde(default)]
    pub per_channel: bool,
    #[serde(default)]
    pub reduce_range: bool,
}

fn builder() -> String {
    "builder".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum Recipe {
    Gguf {
        #[serde(flatten)]
        gguf: GgufRecipe,
        #[serde(default)]
        calibration: CalibSpec,
        #[serde(default)]
        eval: EvalSpec,
    },
    Mlx {
        #[serde(flatten)]
        mlx: MlxRecipe,
        #[serde(default)]
        calibration: CalibSpec,
        #[serde(default)]
        eval: EvalSpec,
    },
    Onnx {
        #[serde(flatten)]
        onnx: OnnxRecipe,
        #[serde(default)]
        eval: EvalSpec,
    },
}

impl Recipe {
    pub fn format(&self) -> &'static str {
        match self {
            Recipe::Gguf { .. } => "gguf",
            Recipe::Mlx { .. } => "mlx",
            Recipe::Onnx { .. } => "onnx",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_frontend_recipe_json() {
        let r: Recipe = serde_json::from_value(json!({
            "format": "gguf", "types": ["Q4_K_M", "IQ3_M"], "imatrix": { "enabled": true },
            "tensor_types": [{ "pattern": "attn_v", "type": "Q6_K" }], "calibration": { "source": "pile-val" }
        }))
        .unwrap();
        match r {
            Recipe::Gguf {
                gguf,
                calibration,
                eval,
            } => {
                assert_eq!(gguf.types.len(), 2);
                assert_eq!(gguf.imatrix.chunks, 128);
                assert_eq!(gguf.base, "auto");
                assert_eq!(calibration.source, "pile-val");
                assert!(eval.kld);
            }
            _ => panic!(),
        }
        let m: Recipe = serde_json::from_value(
            json!({ "format": "mlx", "variants": [{ "bits": 4 }, { "mode": "mxfp4" }] }),
        )
        .unwrap();
        assert_eq!(m.format(), "mlx");
        let o: Recipe =
            serde_json::from_value(json!({ "format": "onnx", "variants": [{}] })).unwrap();
        if let Recipe::Onnx { onnx, .. } = o {
            assert_eq!(onnx.variants[0].label(), "int4-cpu-b32-k_quant");
        }
    }
}

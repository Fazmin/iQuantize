# iQuantize

[![CI](https://github.com/Fazmin/iQuantize/actions/workflows/ci.yml/badge.svg)](https://github.com/Fazmin/iQuantize/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A desktop workspace for quantizing LLMs to **GGUF**, **MLX** and **ONNX**, step by step. You can see exactly what changes, compare the result against the original, and publish it to Hugging Face with a model card that states how it was made.

![The iQuantize live view in light mode, three-quarters of the way through quantizing SmolLM2-135M-Instruct to GGUF Q4_K_M: the Model X-ray of every tensor, the size meter at 106 MB down from 269 MB, the precision mix, system gauges and the llama-quantize log](docs/media/iquantize-hero.png)

**[Watch the 45-second demo](docs/media/iquantize-demo.mp4)**: plan a quantization, watch it run, compare it with the original, measure it, write the model card and publish.

- **Rust + plain JavaScript.** Tauri v2. The UI has no framework, no build step and nothing loaded from a CDN. It talks to Rust only through `invoke` and the event bus, under a strict CSP (`'self'` plus Tauri IPC).
- **SQLite for everything** (`rusqlite`). Secrets (Hugging Face token, OpenAI key) are encrypted with XChaCha20-Poly1305. The key lives in the OS keychain, with a 0600 key file as the fallback.
- **One-click toolchain.** The app downloads `uv`, installs a private Python 3.12, and creates one isolated environment per format. It fetches verified llama.cpp builds for your OS and GPU (Metal, CUDA, Vulkan, ROCm or CPU). The installed tools' `--help` output is probed, so the UI only offers options that the installed version supports.

## What it does

| Area | Highlights |
|---|---|
| **Models** | Search Hugging Face; resumable downloads checked against sha256; local import; architecture, memory and format-compatibility analysis. |
| **Quantize wizard** | Goal → recommendations. Device, memory, runtime, priority, context and use case feed a size/memory/quality estimate for every option, with reasons. "Explore" builds several variants so you can compare them. |
| **GGUF** | Every llama.cpp type, including K-quants and I-quants; importance matrix with calibration data; per-tensor rules; output and embedding overrides; automatic splitting above 48 GB. |
| **MLX** | Bits, group size, affine/mxfp4/nvfp4/mxfp8, mixed recipes, per-layer rules, and AWQ, GPTQ, DWQ and dynamic quantization. |
| **ONNX** | ORT GenAI model builder (int4/int8/fp16/bf16, CPU/CUDA/WebGPU/DML, block size, accuracy level, k-quant, INT8 head) or Optimum + ORT quantization. |
| **Live view** | A tensor map that fills as each tensor is quantized, a pipeline view, a shrinking size meter, the bit-width mix, a calibration perplexity chart, system gauges and logs. |
| **Test & Compare** | Side-by-side chat (streaming, first-divergence highlight, votes); prompt suites with exact-match and ROUGE-L scores; perplexity and KL divergence against the original in the same runtime; speed benchmarks; a size-vs-quality chart. |
| **Docs** | A provenance bundle and a deterministic model card. OpenAI Responses API writing actions can run on one model or up to three in parallel. A guard flags numbers that don't come from your measurements. Version history is kept. |
| **Publish** | Checks the token role and namespace, the 50 GB file limit and license notes; uploads with `huggingface_hub` (Xet/LFS); verifies the result. |
| **Info everywhere** | Every option has a plain-English explanation (306 entries) shown on hover; click ⓘ to pin it, or browse them all in Learn. |
| **User guide** | A built-in, searchable guide to using the app, organised by topic, with step-by-step articles. The **?** in each page's header opens the article for that page. |

## Develop

Requirements: Rust 1.80+ and the Tauri CLI v2 (`cargo install tauri-cli --version ^2`). Node is only needed for tests.

```bash
cd src-tauri
cargo tauri dev          # run the app (the frontend is served straight from ../src)
cargo tauri build        # build an installer for this platform into target/release/bundle
cargo test               # Rust unit tests: parsers are checked against real llama.cpp output
cargo clippy --all-targets -- -D warnings
cd .. && node --test tests/js/   # KB and guide schemas, prompt suites, and info coverage for every control
```

The app installs its own Python, llama.cpp and packages into the app-data folder; nothing touches your system Python. Settings that are useful in development:

- `IQUANTIZE_KEY_FILE=1` stores the secrets key in a file instead of the keychain, which avoids keychain prompts on every rebuild.
- `IQUANTIZE_DEV_SCRIPT=script.json` (debug builds only) runs a JSON script of real IPC calls and page visits at startup and logs the results. It's used for end-to-end runs; see `src/js/lib/devtools.js`.
- `node tests/ui/harness.mjs <outDir> /route …` takes headless Chrome screenshots of the UI with a mocked bridge, using real captured responses from `tests/ui/fixtures`.
- `node tests/ui/demo.mjs docs/media/iquantize-demo.mp4` re-records the demo video above, and `node tests/ui/demo.mjs --hero docs/media/iquantize-hero.png` re-renders the screenshot at the top. It drives the same mocked UI with a cursor and captions, replays a real Q4_K_M run and arena turn from `tests/ui/demo`, and needs ffmpeg. Run it while the machine is awake, because a sleeping Mac throttles the capture.

### Releases

From the project root, on a Mac:

```bash
cargo run release            # bump the patch version (0.2.20 → 0.2.21), then build
cargo run release minor      # 0.2.20 → 0.3.0
cargo run release major      # 0.2.20 → 1.0.0
cargo run release 0.2.21     # set an exact version; giving the current one rebuilds it without bumping
```

Each release updates the version everywhere it appears (`src-tauri/Cargo.toml` and `Cargo.lock`, `tauri.conf.json`, `CITATION.cff` and the citations below). It then builds an Apple Silicon `.dmg` and a Windows installer into `releases/v<version>/`, with a `SHA256SUMS.txt`. `--no-build` only changes the version, and `--only mac` or `--only windows` builds one platform. The tool is `xtask/main.rs`.

- **macOS** is signed with the first Developer ID Application certificate in your keychain (or `APPLE_SIGNING_IDENTITY`). It is notarized when `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` are set.
- **Windows** is cross-compiled with cargo-xwin and packaged with NSIS, and the installer is unsigned. It needs `rustup target add x86_64-pc-windows-msvc`, `cargo install --locked cargo-xwin` and `brew install llvm lld nsis`.

## Layout

```
src/                     plain-JS UI (ES modules), CSS tokens for light/dark, local font + icons
  js/kb/                 knowledge base: every option's explanation
  js/help/               user guide: one file of articles per chapter (see js/help/index.js for the format)
  js/views/              Home, Models, Quantize wizard, Jobs, Test & Compare, Docs, Publish, Environment, Settings, User guide, Learn
src-tauri/
  src/toolchain/         uv / Python / venvs / llama.cpp installers, capability probes, doctor
  src/quant/             catalog, estimator, recommender, GGUF/MLX/ONNX pipelines, parsers, artifacts
  src/eval/              inference runners (llama-server, mlx_lm.server, ONNX stdio), arena, suites, speed/quality
  src/docs/, ai.rs       provenance, model card, number guard, OpenAI Responses API
  src/publish.rs         Hugging Face staging, upload, verification
  drivers/*.py           Python drivers (embedded in the binary) speaking a JSON-lines protocol
  migrations/            SQLite schema
  resources/             pinned toolchain manifest, prompt suites
xtask/main.rs            release tool behind `cargo run release` (the root Cargo.toml exists only for it)
```

## Platform notes

- macOS on Apple Silicon is the primary target and was verified end to end: toolchain install, download, all three formats with evaluation, arena, suites, speed and quality.
- Windows and Linux builds use their own llama.cpp variants and draw their own title-bar controls. CI builds and tests them, but they still need a manual run on real machines.
- MLX needs Apple Silicon; elsewhere the UI disables it and says why.

## Contributing

Contributions are welcome, especially testing on Windows and Linux. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, the project's guidelines and the checks to run before a pull request. Everyone who has contributed is listed in [CONTRIBUTORS.md](CONTRIBUTORS.md).

## Citing iQuantize

If you use iQuantize in research, or publish models made with it, please cite it. On GitHub, **Cite this repository** in the sidebar gives ready-made APA and BibTeX citations from [CITATION.cff](CITATION.cff). You can also copy one of these:

**BibTeX**

```bibtex
@software{nizam_iquantize_2026,
  author  = {Nizam, Fazmin},
  title   = {{iQuantize: A Desktop Workspace for Quantizing Large Language Models to GGUF, MLX and ONNX}},
  year    = {2026},
  version = {0.2.21},
  url     = {https://github.com/Fazmin/iQuantize},
  license = {MIT}
}
```

**APA**

> Nizam, F. (2026). *iQuantize: A desktop workspace for quantizing large language models to GGUF, MLX and ONNX* (Version 0.2.21) [Computer software]. https://github.com/Fazmin/iQuantize

When you publish a model made with iQuantize, its model card and `quantization_report.json` already record the exact tool versions, recipe and measurements, so others can reproduce it.

## License

iQuantize is released under the [MIT License](LICENSE).

It bundles the [Inter](https://github.com/rsms/inter) font ([SIL Open Font License 1.1](src/assets/fonts/Inter-LICENSE.txt)) and [Lucide](https://lucide.dev) icons ([ISC License](src/assets/Lucide-LICENSE.txt)). The tools the app downloads at runtime (llama.cpp, uv, Python, MLX, ONNX Runtime GenAI and the Hugging Face libraries) are not bundled and keep their own licences.

Models you quantize keep the licence of the original model. Check it before publishing; the Publish page flags common requirements such as Llama and Gemma terms.

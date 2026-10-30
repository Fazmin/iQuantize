// Quantize: choosing a format, the wizard, and per-format options.

export default [
  {
    id: 'quantize.formats',
    title: 'Choose a format: GGUF, MLX or ONNX',
    summary: 'Pick the format that matches where the model will run. You can build several at once and compare them.',
    body: [
      { p: 'The right format depends on the app or runtime that will load the model, not on the model itself. If you are unsure, build more than one; each becomes its own job and you can compare them afterwards.' },
      {
        table: {
          head: ['', 'GGUF', 'MLX', 'ONNX'],
          rows: [
            ['Runs in', 'llama.cpp, LM Studio, Ollama, Jan and many more', 'mlx-lm, LM Studio (MLX), other MLX apps', 'ONNX Runtime GenAI: DirectML, CUDA, CPU, WebGPU'],
            ['Platforms', 'Every OS, CPU or GPU', 'Apple Silicon Macs only', 'Windows, Linux, servers, mobile, browser'],
            ['Output', 'One `.gguf` file per type', 'A folder per variant', 'A folder per variant'],
            ['Strength', 'Widest support, many quantization types', 'Usually fastest on a Mac', 'Best fit for Windows apps and the web'],
            ['Choices', '30+ types, importance matrix, per-tensor rules', 'Bits, group size, modes, mixed recipes, AWQ/GPTQ/DWQ', 'INT4/INT8/FP16, block size, execution provider'],
          ],
        },
      },
      { h: 'Quick guidance' },
      {
        defs: [
          ['Mac with Apple Silicon', 'MLX for speed in MLX apps; GGUF if you use Ollama or want one file that works everywhere.'],
          ['Windows or Linux PC with a GPU', 'GGUF for llama.cpp, LM Studio and Ollama. ONNX if you are building a Windows app with DirectML or a CUDA server.'],
          ['CPU only', 'GGUF. Smaller K-quants such as Q4_K_M keep it responsive.'],
          ['Web browser', 'ONNX with the WebGPU execution provider.'],
          ['Phone or edge device', 'GGUF or ONNX at 4 bits, depending on your runtime.'],
        ],
      },
      { tip: 'The Goal step of the wizard makes this choice for you: tell it your device and runtime and it only recommends formats that will work there.' },
      { note: 'MLX needs a Mac with Apple Silicon (M1 or newer). On other machines its card is shown but disabled.' },
    ],
    terms: ['format.compare', 'format.gguf', 'format.mlx', 'format.onnx'],
  },
  {
    id: 'quantize.wizard',
    title: 'Use the Quantize wizard',
    summary: 'Six steps take you from a model and a goal to running jobs: Model, Goal, Format, Options, Calibration & tests, and Review & start.',
    body: [
      { p: 'Open the wizard from **Quantize** in the sidebar, the **New quantization** button, or by pressing [[C]]. From a model’s page, **Quantize** opens it with that model already chosen.' },
      { p: 'The steps are listed on the left with a running summary of what you will get: the chosen model, each output with its estimated size, and the estimated total. Click any step to jump to it. Your choices are kept while you visit other pages, until you start or click **Reset**.' },
      {
        steps: [
          { title: 'Model', text: 'Choose the model to quantize. Start from the original full-precision weights (usually BF16 or FP16). Models still downloading are greyed out. If you only have one model it is picked for you.' },
          { title: 'Goal', text: 'Say where the model will run: device, memory, runtime, priority, context length and main use. iQuantize ranks every option and recommends the best fit per format. See [Set a goal and read the recommendations](help:quantize.goal).' },
          { title: 'Format', text: 'Pick one or more of GGUF, MLX and ONNX. Each card shows whether this model is supported. If a format’s tools are not installed, clicking it takes you to Environment.' },
          { title: 'Options', text: 'Fine-tune the recipe for each format on its own tab. Defaults are sensible and sizes update as you change things. See [GGUF options](help:quantize.gguf), [MLX options](help:quantize.mlx) and [ONNX options](help:quantize.onnx).' },
          { title: 'Calibration & tests', text: 'Choose calibration text for methods that need it, and whether to measure quality automatically. See [Calibration and automatic evaluation](help:quantize.calibration).' },
          { title: 'Review & start', text: 'Check the outputs, sizes, temporary disk space and the pipeline for each format, then click **Start quantization**.' },
        ],
      },
      { p: 'Each format runs as its own background job. After starting, the app opens the first job so you can watch it; the others wait their turn. See [Read the live view](help:jobs.live-view).' },
      { h: 'Before you start' },
      {
        list: [
          'Install the tools for each format you pick (Environment). The wizard tells you if something is missing.',
          'Check free disk space. GGUF needs about the size of the original again for a full-precision intermediate, plus the outputs. The Review step shows the temporary space needed.',
          'For your first run, accept the defaults. You can always run again with different options; slow steps such as conversion are cached and reused.',
        ],
      },
      { h: 'If it will not start' },
      { p: 'The **Could not start** message says why. The most common reasons:' },
      {
        defs: [
          ['“Choose at least one format”', 'Go back to Format and select one.'],
          ['“This model isn’t ready yet”', 'Its download is still running or failed. Check Models.'],
          ['“The … component is not installed”', 'Install it in Environment. Hub & data tools are also needed whenever calibration or evaluation is on.'],
          ['“Pick at least one quantization type”', 'Select a GGUF type in Options.'],
          ['“… is not supported by the installed llama.cpp”', 'Choose a different type, or update llama.cpp in Environment.'],
        ],
      },
      { warn: 'When you start several formats, they are submitted one by one. If a later format fails its check, the earlier ones are already running; look in Jobs before trying again.' },
      { action: { label: 'Open the wizard', go: '#/quantize', icon: 'wand-sparkles' } },
    ],
    terms: ['concept.quantization', 'concept.bpw', 'concept.disk_space'],
  },
  {
    id: 'quantize.goal',
    title: 'Set a goal and read the recommendations',
    summary: 'How the Goal step turns your device, memory and priorities into ranked options with size, memory and quality estimates.',
    body: [
      { h: 'The questions' },
      {
        defs: [
          ['[Device](term:goal.device)', 'Apple Silicon Mac, NVIDIA GPU, AMD GPU, CPU only, Phone / edge, or Web browser. Preset from what the app detects on this machine.'],
          ['[Memory available for the model](term:goal.memory)', 'Unified memory on a Mac, VRAM on a GPU, or RAM for CPU. Preset from this machine.'],
          ['Where will you run it?', 'No preference, llama.cpp, LM Studio, Ollama, MLX apps, ONNX Runtime, or In the browser. This decides which formats are considered.'],
          ['[Priority](term:goal.priority)', 'A slider from **Best quality** to **Smallest & fastest**. The middle is **Balanced**.'],
          ['[Context length you need](term:goal.context)', '2k to 128k tokens. Longer context needs a bigger KV cache, which takes memory away from the weights.'],
          ['Main use', 'Chat, Code, RAG / docs, Agents & tools, Creative or Multilingual. Code, agents and multilingual use are more sensitive to quantization, so they push towards higher quality.'],
        ],
      },
      { p: 'Recommendations update a moment after you change anything.' },
      { h: 'How it decides' },
      {
        list: [
          '**Memory budget.** Only part of the memory you enter is usable for the model: about 72% on a Mac, 92% on a dedicated GPU, 60% for CPU, and less on phones and browsers. The budget line above the cards shows the result and the KV cache at your context length.',
          '**Fit.** An option fits when its file size plus KV cache plus a little runtime overhead is within the budget.',
          '**Quality.** Each type has an expected loss measured on a reference 8B model. Smaller models lose more, and sensitive uses (code, agents, multilingual) raise the penalty.',
          '**Ranking.** Your priority weighs quality against size. Options that do not fit go to the bottom.',
        ],
      },
      { h: 'Reading a recommendation card' },
      { p: 'There is one card per format, showing the best option that fits. Each card shows:' },
      {
        list: [
          'The format and variant (for example **GGUF · Q4_K_M**) and a 1–5 star quality rating.',
          'File size, [bits per weight](term:concept.bpw), and the memory it needs to run.',
          'A quality tier, from **Near-lossless** and **Excellent** down to **Noticeable loss** and **Heavy loss**.',
          'Reasons it was chosen, and warnings marked ⚠, such as “Small models lose a lot at 2–3 bits; prefer 4 bits or more.”',
        ],
      },
      { p: 'Click **Use this** to apply it. The wizard selects that format and variant (and turns on the importance matrix if the type needs one), but stays on this step so you can review. Open **All options considered** to see every candidate with its size, memory, expected quality and whether it fits.' },
      { h: 'Explore several options' },
      { p: 'Not sure which trade-off you want? Click **Explore: try the N best options and compare**. The wizard puts up to five of the best fitting options into the recipe, turns on automatic evaluation, and builds them all. When the jobs finish, the results table and Test & Compare’s size-vs-quality chart show which one gives the best quality for its size.' },
      { note: 'If nothing fits, lower the context length, raise the memory, or pick a smaller model.' },
      { tip: 'Estimates are calibrated against real llama.cpp file sizes and are usually within a few percent. Automatic evaluation tells you the real quality after the build.' },
    ],
    terms: ['goal.recommendation', 'goal.explore', 'concept.memory_budget', 'concept.kv_cache', 'concept.bpw'],
  },
  {
    id: 'quantize.gguf',
    title: 'GGUF options',
    summary: 'Quantization types, the importance matrix, and advanced controls such as per-tensor rules and file splitting.',
    body: [
      { h: 'Quantization types' },
      { p: 'Pick one or more types; **each becomes its own file**, all made from a single conversion. The default is **Q4_K_M**. Only the types your installed llama.cpp supports are shown. Each tile shows its estimated size, bits per weight and quality tier, and whether it fits your goal’s memory budget.' },
      {
        table: {
          head: ['Group', 'Types', 'When to use'],
          rows: [
            ['Recommended', 'Q8_0, Q6_K, Q5_K_M, Q4_K_M, IQ4_XS, Q3_K_M, IQ3_M', 'Start here. Q4_K_M is the community default; Q5_K_M and Q6_K are closer to the original.'],
            ['[K-quants](term:concept.kquants)', 'Q6_K … Q2_K_S', 'Good quality at every size, fast on CPU and GPU.'],
            ['[I-quants](term:concept.iquants)', 'IQ4_XS … IQ1_S', 'Smallest files for their quality. Below 4 bits they need an importance matrix.'],
            ['Legacy & special', 'Q8_0, Q5_1, Q4_0, ternary, MXFP4_MOE, F16, BF16', 'Compatibility with older runtimes, special model types, or full precision.'],
          ],
        },
      },
      { p: 'Types marked with a lock require an importance matrix. Selecting one turns it on automatically.' },
      { h: 'Importance matrix' },
      { p: 'An [importance matrix](term:concept.imatrix) runs sample text through the model to find which weights matter most, then protects them during quantization. It noticeably improves quality below 4 bits and is required for the smallest I-quants. It is computed once and reused for every type in the job, and cached for later runs.' },
      {
        defs: [
          ['[Calibration chunks](term:gguf.opt.imatrix_chunks)', 'How many pieces of text to measure (8–2000, default 128). More is slower but steadier.'],
          ['[Tokens per chunk](term:gguf.opt.imatrix_ctx)', 'Length of each piece (128–8192, default 512).'],
        ],
      },
      { p: 'Choose the calibration text in the next step. See [Calibration and automatic evaluation](help:quantize.calibration).' },
      { h: 'Advanced' },
      {
        defs: [
          ['Intermediate precision', 'The full-precision GGUF made before quantizing: Auto, BF16, F16, F32 or Q8_0. Auto keeps the model’s own precision.'],
          ['[Output (LM head) type](term:gguf.opt.output_tensor_type)', 'Override the precision of the final layer. Raising it can help small models.'],
          ['[Token embedding type](term:gguf.opt.token_embedding_type)', 'Override the precision of the input embeddings.'],
          ['[Leave output tensor unquantized](term:gguf.opt.leave_output_tensor)', 'Keep the final layer at full precision.'],
          ['[Pure](term:gguf.opt.pure)', 'Use exactly the chosen type everywhere instead of the usual mix that protects sensitive tensors.'],
          ['[Per-tensor precision rules](term:gguf.opt.tensor_type)', 'Give tensors that match a pattern their own type, for example `attn_v` → Q6_K. Patterns match llama.cpp names such as `blk.3.attn_v`.'],
          ['[Split files larger than](term:gguf.opt.split_max_size)', 'Files at or above this size (default 48 GB) are split into shards, because Hugging Face rejects single files over 50 GB.'],
          ['[Low-memory conversion](term:gguf.opt.use_temp_file)', 'Uses a temporary file during conversion to reduce memory use, at the cost of speed.'],
        ],
      },
      { h3: 'Rule presets' },
      {
        list: [
          '**Protect attention V + FFN down** raises the two most sensitive tensor kinds to Q6_K.',
          '**First/last layers higher** raises the first two and last two blocks to Q6_K.',
          '**Embeddings & head at Q8_0** sets both overrides above to Q8_0.',
          '**Clear** removes all rules (it does not reset the embedding and head overrides).',
        ],
      },
      { warn: 'Rule patterns are regular expressions and are not checked before the job starts. Test a new pattern on a small model first.' },
      { note: 'On small models you may see a note that some rows are not a multiple of 256 wide. llama.cpp then stores those tensors with a simpler format, so files come out a little larger than the type name suggests. This is normal.' },
    ],
    terms: ['format.gguf', 'concept.kquants', 'concept.iquants', 'concept.imatrix', 'concept.mixed_precision', 'gguf.preset.protect_sensitive'],
  },
  {
    id: 'quantize.mlx',
    title: 'MLX options',
    summary: 'Variants with bits, group size and mode, mixed-precision recipes, calibrated methods and per-layer rules. Apple Silicon only.',
    body: [
      { p: 'MLX outputs are folders that mlx-lm and MLX-based apps load directly. You can build several **variants** in one job; each becomes its own folder.' },
      { h: 'Method' },
      {
        defs: [
          ['[Standard](term:mlx.method.convert)', 'Plain round-to-nearest quantization. Fast and needs no calibration. The default.'],
          ['[AWQ](term:mlx.method.awq)', 'Activation-aware: protects the weights that matter most for real inputs.'],
          ['[GPTQ](term:mlx.method.gptq)', 'Compensates for rounding errors layer by layer using sample data.'],
          ['[DWQ (distilled)](term:mlx.method.dwq)', 'Tunes the quantized model to match the original’s outputs. The slowest and often the best.'],
          ['[Dynamic](term:mlx.method.dynamic_quant)', 'Spends bits where they matter to hit a **Target bits per weight**.'],
        ],
      },
      { p: 'Methods your installed mlx-lm does not provide are greyed out. The calibrated methods add **Calibration samples** and **Sequence length**; if you leave them alone, mlx-lm’s own defaults are used.' },
      { warn: 'With AWQ, GPTQ, DWQ and Dynamic, only bits, group size and the calibration settings on this tab are used. The variant’s mode, mixed recipe, storage type, per-layer rules and the calibration text in the next step do not apply to these methods.' },
      { h: 'Variant settings' },
      {
        defs: [
          ['Quantization mode', '[affine](term:mlx.mode.affine) (classic integer quantization with scales), or block formats such as [mxfp4](term:mlx.mode.mxfp4), [nvfp4](term:mlx.mode.nvfp4) and [mxfp8](term:mlx.mode.mxfp8), which fix bits and group size themselves.'],
          ['Bits', '2, 3, 4, 5, 6 or 8 (affine only). 4 is the usual balance; 6 and 8 are close to the original.'],
          ['[Group size](term:concept.group_size)', '32, 64 or 128 (affine only). Smaller groups are more accurate and slightly larger.'],
          ['[Mixed-precision recipe](term:concept.mixed_precision)', 'Keeps sensitive layers at higher precision, for example mixed_4_6 uses 4 and 6 bits.'],
          ['Unquantized parts stored as', 'Precision for the parts that stay unquantized: the model’s own, float16, bfloat16 or float32.'],
        ],
      },
      { p: 'Click **Add another variant** to build more than one, for example `4bit-gs64` and `mixed_4_6-gs64`, and compare them afterwards.' },
      { h: 'Other options' },
      {
        list: [
          '[Per-layer rules](term:mlx.opt.rules): set a precision for module paths that match a pattern, such as `lm_head|v_proj` → 6-bit, or keep them at full precision. The first matching rule wins.',
          '[Trust remote code](term:mlx.opt.trust_remote_code): only for models that ship custom Python code. Turn it on only for publishers you trust.',
        ],
      },
    ],
    terms: ['format.mlx', 'mlx.apple_only', 'concept.group_size', 'concept.mixed_precision', 'concept.awq', 'concept.gptq', 'concept.dwq'],
  },
  {
    id: 'quantize.onnx',
    title: 'ONNX options',
    summary: 'Engine, precision, execution provider, block size and algorithm for ONNX Runtime GenAI models.',
    body: [
      { h: 'Engine' },
      {
        defs: [
          ['[ORT GenAI model builder](term:onnx.engine.builder)', 'Recommended. Produces models ready for ONNX Runtime GenAI, which Test & Compare can run.'],
          ['[Optimum + ORT quantizer](term:onnx.engine.optimum)', 'A generic exporter for architectures the builder does not support. INT8 variants use dynamic INT8; other variants use INT4 weight-only quantization.'],
        ],
      },
      { h: 'Variant settings' },
      {
        defs: [
          ['Precision', '[INT4](term:onnx.precision.int4) (smallest), [INT8](term:onnx.precision.int8), [FP16](term:onnx.precision.fp16), BF16 or FP32. Default INT4.'],
          ['Runs on', 'The execution provider the model is optimised for: [CPU](term:onnx.ep.cpu), [WebGPU](term:onnx.ep.webgpu), [CUDA](term:onnx.ep.cuda) (when an NVIDIA GPU is detected) or [DirectML](term:onnx.ep.dml) (Windows).'],
          ['[Block size](term:onnx.opt.block_size)', '32, 64 or 128 weights share one scale (INT4 and INT8). Smaller blocks are more accurate.'],
          ['[Algorithm](term:onnx.opt.algo_config)', 'RTN (fast) or [K-quant](term:onnx.algo.k_quant) (better quality, slow on CPU: minutes even for small models).'],
          ['[Compute accuracy level](term:onnx.opt.accuracy_level)', 'Precision used inside matrix multiplications. Level 4 (int8) is fastest on CPU.'],
          ['[Symmetric](term:onnx.opt.is_symmetric)', 'Quantize without a zero point. On by default.'],
          ['Keep the output head at INT8', 'INT4 only. Keeps the final layer more precise for a small size cost.'],
        ],
      },
      { p: 'The first variant defaults to INT4 with K-quant and an INT8 head, a good quality-for-size starting point. **Add another variant** adds an INT8 build for comparison.' },
      { note: 'Options your installed builder does not accept are skipped quietly. Variant names such as `int4-cpu-b32-k_quant-head8` record the settings used.' },
      { tip: 'If the builder does not support your model’s architecture, the job fails with a hint to try the Optimum engine, GGUF or MLX.' },
    ],
    terms: ['format.onnx', 'onnx.engine.builder', 'onnx.opt.block_size', 'onnx.algo.k_quant', 'onnx.ep.cpu'],
  },
  {
    id: 'quantize.calibration',
    title: 'Calibration and automatic evaluation',
    summary: 'Choose sample text for the importance matrix, and let each job measure how close its outputs stay to the original.',
    body: [
      { h: 'Calibration text' },
      { p: '[Calibration](term:concept.calibration) text is a sample of writing that some methods use to decide which weights matter most. It is only needed when the GGUF importance matrix is on (or a type requires it) or an MLX method other than Standard is selected. Otherwise the step says no calibration is needed.' },
      {
        defs: [
          ['[WikiText-2](term:calib.wikitext2)', 'Clean encyclopedic English. A common, safe default.'],
          ['[The Pile (sample)](term:calib.pile_val)', 'Mixed web, books, code and papers: broader coverage.'],
          ['[C4 English](term:calib.c4)', 'Large cleaned web crawl text.'],
          ['[My own text](term:calib.custom_file)', 'A `.txt`, `.jsonl`, `.json` or `.md` file that looks like your real use. From JSON the app reads `text`, `content`, `prompt`, `completion`, `response` and chat `messages`.'],
          ['[A Hugging Face dataset](term:calib.hf_dataset)', 'Any dataset with a text column: enter its id, split and column name.'],
        ],
      },
      { tip: 'For a coding or multilingual model, your own text in that domain usually beats the presets.' },
      { p: 'Downloaded text is stored in your workspace’s `calibration` folder and reused on later runs.' },
      { warn: 'If you choose **My own text** without picking a file, the job fails when it reaches calibration with “Choose a calibration text file”.' },
      { h: 'Automatic evaluation' },
      { p: 'With **Measure quality: perplexity + KL divergence vs the original** turned on (the default), each job finishes by comparing every output against the original model on the same text. The results appear in the job’s Results table and in Test & Compare.' },
      {
        defs: [
          ['Evaluation size', '10–200 chunks (default 40). More chunks give steadier numbers and take longer.'],
          ['Tokens per chunk', '512, 1024 or 2048.'],
        ],
      },
      { p: 'Evaluation always uses the WikiText-2 test split, so numbers are comparable across formats and runs. To learn what the numbers mean, see [Measure quality](help:test.quality).' },
    ],
    terms: ['concept.calibration', 'concept.imatrix', 'calib.size', 'eval.ppl', 'eval.kld'],
  },
  {
    id: 'quantize.outputs',
    title: 'Where outputs go and how re-runs work',
    summary: 'File locations for each format, what is cached between runs, and how to run again with different options.',
    body: [
      { h: 'Output locations' },
      { p: 'Everything is saved in your workspace (see **Settings → Workspace**):' },
      {
        table: {
          head: ['Format', 'Location'],
          rows: [
            ['GGUF', '`outputs/<model>/gguf/<Model>-<TYPE>.gguf` (large files are split into numbered shards)'],
            ['MLX', '`outputs/<model>/mlx/<Model>-MLX-<variant>/` (a folder)'],
            ['ONNX', '`outputs/<model>/onnx/<Model>-ONNX-<variant>/` (a folder)'],
          ],
        },
      },
      { p: 'The fastest way to find a file is the **Reveal** button next to it in the job’s Results table or on the model’s **Quantized versions** tab. GGUF files are also given SHA-256 checksums for publishing.' },
      { h: 'Caching' },
      { p: 'Slow steps are saved and reused automatically when nothing they depend on has changed. A reused step shows **Reused from cache** in the job’s pipeline:' },
      {
        list: [
          'The full-precision GGUF conversion (per model, revision, precision and llama.cpp version).',
          'The importance matrix (per calibration text and settings).',
          'Reference measurements of the original model used for evaluation.',
          'Calibration and evaluation text.',
        ],
      },
      { h: 'Running again' },
      { p: 'There is no retry button. To try different options, or to repeat a failed job, run the wizard again. Thanks to caching, a second run on the same model usually skips straight to quantizing. Building the same MLX or ONNX variant again replaces its folder.' },
      { note: 'Each job also records exactly how it was made. Docs uses this to write a model card with the real recipe and measurements.' },
    ],
    terms: ['concept.sharding', 'settings.workspace'],
  },
];

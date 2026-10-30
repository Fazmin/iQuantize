// Models: adding originals, downloads, local folders, and the model page.

export default [
  {
    id: 'models.add-hf',
    title: 'Add a model from Hugging Face',
    summary: 'Search Hugging Face, check that a model will convert before you download it, and start a resumable, verified download.',
    body: [
      { p: 'iQuantize starts from an **original, full-precision model**: the weights as the authors published them, usually in [safetensors](term:concept.safetensors) files. Quantizing a model that is already quantized compounds the error, so pick the original repository whenever you can.' },
      { h: 'Find a model' },
      {
        steps: [
          { title: 'Open the browser', text: 'In **Models**, click **Add from Hugging Face**. You can also choose **Add a model from Hugging Face** in the command palette ([[⌘+K]]).' },
          { title: 'Search or paste an id', text: 'Type a few words such as `qwen instruct`; results update as you type. Search matches the repository name (`owner/name`), not its description. The first 50 matches load straight away and scrolling down loads 50 more, up to 100. If you already know the id, paste it in the form `owner/name`, for example `HuggingFaceTB/SmolLM2-135M-Instruct`, and its details load straight away.' },
          { title: 'Narrow the list', text: 'Use **Sort** to order by **Most downloaded**, **Trending**, **Most liked** or **Recently updated**, and **Size** to show only models under 1B, 1–4B, 4–14B or 14B and up.' },
          { title: 'Pick a result', text: 'Each result shows its parameter count, licence, downloads, likes and when it was last updated. A lock means the model is gated. Models you already have show **In library**.' },
          { title: 'Check the details', text: 'The right-hand pane shows parameters, download size, context length and precision; whether GGUF, MLX and ONNX can convert it; and the architecture, layers, licence, chat template and exact revision.' },
          { title: 'Download', text: 'Click **Download** followed by the size. The footer shows how much free space your workspace has. The browser closes and a progress card appears at the top of the Models page.' },
        ],
      },
      { tip: 'Keyboard: [[↑]] [[↓]] move through results and show each one’s details, [[↵]] opens the highlighted model, and [[⌘+↵]] ([[Ctrl+↵]] on Windows and Linux) downloads it.' },
      { p: 'Repositories that are already quantized (GGUF, MLX, GPTQ, AWQ and similar) are hidden, because they make poor starting points. Turn on **Include quantized** to see them; their Download button is not highlighted.' },
      { h3: 'Models already in your library' },
      { p: 'For a model you already have, the browser offers **Open in library** and **Download again**, which re-checks every file and fetches anything missing. If an earlier download failed, the button reads **Resume download**.' },
      { note: 'Search only lists text-generation models. If a model you want is tagged differently on Hugging Face, paste its `owner/name` id instead; it still loads.' },
      { h: 'Good starting points' },
      { p: 'With an empty search box, the browser shows these suggestions above a list of popular models. They are good for learning the flow:' },
      {
        table: {
          head: ['Model', 'Why'],
          rows: [
            ['`HuggingFaceTB/SmolLM2-135M-Instruct`', 'Tiny (135M parameters). Every step finishes in minutes. Best for a first try.'],
            ['`Qwen/Qwen2.5-0.5B-Instruct`', 'Small multilingual chat model.'],
            ['`HuggingFaceTB/SmolLM2-1.7B-Instruct`', 'Capable small model; outputs are easier to judge.'],
            ['`Qwen/Qwen3-4B`', 'Strong mid-size model.'],
            ['`meta-llama/Llama-3.2-1B-Instruct`', 'Gated: you must accept Meta’s licence first.'],
          ],
        },
      },
      { h: 'Read the format verdicts' },
      { p: 'Before you download anything, the browser tells you whether each format can convert this architecture with the tools you have installed:' },
      {
        defs: [
          ['Green', 'Supported. For example, “llama.cpp’s converter supports LlamaForCausalLM.”'],
          ['Amber', 'Possible with caveats: the checkpoint is already quantized, it has no .safetensors weights, or (for ONNX) only the generic exporter might work.'],
          ['Red', 'Not supported here, for example MLX on a machine without Apple Silicon, or an architecture the installed converter does not list.'],
          ['Plain', 'Unknown, because that format’s tools are not installed yet. Install them in Environment to get a verdict.'],
        ],
      },
      { h: 'Gated and private models' },
      { p: 'Some publishers require you to accept a licence before downloading. For these:' },
      {
        steps: [
          'Open the model’s page on huggingface.co (the **Hugging Face ↗** button in the browser) and accept the licence while signed in.',
          'Add a Hugging Face token in **Settings → Accounts**. A read token is enough for downloading. See [Connect your accounts](help:setup.accounts).',
          'Come back and click **Download** again.',
        ],
      },
      { warn: 'If you skip either step, the download fails with a message explaining that the model is gated. Details such as architecture may show “—” until you have access.' },
      { action: { label: 'Add a model now', go: '#/models?add=hf', icon: 'download' } },
    ],
    terms: ['concept.safetensors', 'concept.gated', 'concept.license', 'concept.already_quantized', 'concept.revision', 'hub.token'],
  },
  {
    id: 'models.downloads',
    title: 'How downloads work',
    summary: 'Progress, resuming after an interruption, checksum verification, disk space, and what is fetched.',
    body: [
      { h: 'Watching progress' },
      { p: 'Each download has a card at the top of the Models page with a progress bar, the current stage, the amount downloaded and the speed. A download goes through three stages:' },
      {
        steps: [
          { title: 'Resolve files', text: 'Works out which files the model needs at the exact revision you saw in the dialog.' },
          { title: 'Download weights', text: 'Fetches up to four files at once.' },
          { title: 'Inspect model', text: 'Reads the configuration and tensor headers so the model page can show its architecture and tensor map.' },
        ],
      },
      { p: 'Click **Log** on the card to see what is happening, **Cancel** to stop, or the arrow to open the full job page. When the download finishes, the card disappears and the model appears in the list.' },
      { tip: 'You can leave the page or start other work. Downloads run in the background and do not count towards the “Heavy jobs at once” limit in Settings.' },
      { h: 'Resuming and retrying' },
      { p: 'Every file downloads to a temporary `.part` file. If a download is cancelled, fails or the app closes, those partial files stay on disk. To continue, open **Add from Hugging Face** again, choose the same model and click **Download**. Files that are already complete are skipped and partial files resume where they stopped.' },
      { h: 'Verification' },
      { p: 'Hugging Face publishes a SHA-256 checksum for each large weight file. iQuantize checks every one after downloading. If a file does not match, the download fails with a message that the file “failed its checksum”; run it again and the corrupted part is discarded. Small files such as the configuration and tokenizer have no published checksum.' },
      { h: 'Disk space' },
      { p: 'Before starting, the app checks that you have the download size plus 1 GB free in your workspace. If not, you see “Not enough free space: need X, have Y”. Free some space, or move the workspace to a bigger drive in **Settings → Workspace**.' },
      { note: 'Downloading is only the start. Quantizing a 7–8B model needs roughly 30–40 GB free for the original, a full-precision intermediate and the outputs.' },
      { h: 'What gets downloaded' },
      {
        list: [
          'The `.safetensors` weights and their index (old `pytorch_model*.bin` files only if there are no safetensors).',
          'Configuration, tokenizer and chat-template files, the README and the licence.',
          'Any custom Python code the model ships with.',
          'Not downloaded: sub-folders such as `original/` or `onnx/`, and ready-made GGUF exports.',
        ],
      },
      { p: 'Models are saved in your workspace under `models/<owner>__<name>`.' },
    ],
    terms: ['concept.safetensors', 'concept.sharding', 'concept.disk_space', 'concept.revision'],
  },
  {
    id: 'models.import',
    title: 'Import a model folder from disk',
    summary: 'Use a model you already have, without copying it, as long as it is a Hugging Face–style folder.',
    body: [
      { p: 'If you already have a model on disk, for example one you fine-tuned or downloaded with another tool, you can use it directly.' },
      {
        steps: [
          { title: 'Start the import', text: 'In **Models**, click **Import folder**, or choose **Import a local model folder** in the command palette.' },
          { title: 'Choose the folder', text: 'Pick the folder that contains `config.json` and the `.safetensors` files. Choose the folder itself, not a file inside it.' },
          { title: 'Done', text: 'The model appears in the list with the folder’s name, and its page shows the same analysis as a downloaded model.' },
        ],
      },
      { h: 'Requirements' },
      {
        list: [
          'The folder must contain `config.json`. Without it you see “This folder has no config.json, so it is not a Hugging Face model folder”.',
          'Weights should be top-level `.safetensors` files. Without them the model imports, but GGUF conversion is flagged and the tensor map is empty.',
          'A licence is picked up from a `license:` line at the top of `README.md`, if there is one.',
        ],
      },
      { h: 'Good to know' },
      {
        list: [
          'Files are **not copied**: iQuantize reads the model from where it is, so it takes no extra space.',
          'Importing the same folder again refreshes the existing entry instead of adding a duplicate.',
          'If you move or delete the folder later, the model page says “The model folder is missing” and shows the old path. Import it again from its new location.',
          'Removing an imported model from the library never touches your folder.',
        ],
      },
      { action: { label: 'Import a folder', go: '#/models?add=local', icon: 'folder-open' } },
    ],
    terms: ['concept.safetensors', 'concept.tokenizer', 'concept.chat_template'],
  },
  {
    id: 'models.detail',
    title: 'Understand the model page',
    summary: 'Architecture, format support, memory needs, the tensor map, and the quantized versions you have made.',
    body: [
      { p: 'Click any model in **Models** to open its page. The header shows the name, its format badges, a link to Hugging Face (or the local path), the licence and the revision. The page has three tabs: **Overview**, **Tensor map** and **Quantized versions**.' },
      { h: 'Overview' },
      { h3: 'Architecture' },
      {
        defs: [
          ['Architecture', 'The model family as declared in its configuration, such as `LlamaForCausalLM`. Converters support specific families.'],
          ['[Parameters](term:concept.params)', 'How many weights the model has. This is the main driver of file size and memory.'],
          ['Layers, Hidden size', 'How deep and wide the network is.'],
          ['[Attention heads](term:concept.attention)', 'Query heads and key/value heads. Fewer key/value heads (GQA) means a smaller KV cache.'],
          ['[Context length](term:concept.context_length)', 'The longest input the model was built for.'],
          ['Vocabulary', 'Number of tokens, and whether input and output embeddings are tied.'],
          ['[Experts](term:concept.moe)', 'Only for mixture-of-experts models: how many experts exist and how many run per token.'],
          ['Stored as', 'The original precision, total size and number of tensors.'],
        ],
      },
      { h3: 'Format support' },
      { p: 'The same green, amber and red verdicts as in the Hugging Face browser, with the reason for each. See [Add a model from Hugging Face](help:models.add-hf).' },
      { h3: 'Memory needed to run' },
      { p: 'A table of how much memory the model needs at several context lengths, for the original and for a typical ~4.8 bits-per-weight quantization. Memory is the weights plus the [KV cache](term:concept.kv_cache), which grows with context length. Use it to judge whether a model will fit on the device you are targeting.' },
      { h3: 'Warnings you may see' },
      {
        list: [
          '**Already quantized**: quantizing again compounds the error. Find the original repository.',
          '**Multimodal model**: iQuantize quantizes the language part. Vision or audio parts may need extra files (for example an mmproj file for llama.cpp).',
          '**Folder missing**: an imported model was moved or deleted.',
        ],
      },
      { h: 'Tensor map' },
      { p: 'A picture of every weight tensor in the model. Each column is one transformer block, and you can hover a cell for its name, shape and type. Below it, a table summarises the stored types with their parameter count, bytes and bits per weight. During quantization, the same map fills with each tensor’s new precision. See [Read the live view](help:jobs.live-view).' },
      { h: 'Quantized versions' },
      { p: 'Every output you have made from this model, with its format, variant, size, [bits per weight](term:concept.bpw) and role. **Reference** rows are full-precision copies used for fair comparisons; **Quantized** rows are your results. Each row has **Reveal** to show the files and **Test** to open it in Test & Compare.' },
      { h: 'Actions' },
      {
        defs: [
          ['**Quantize**', 'Opens the wizard with this model already selected.'],
          ['**Test**', 'Opens Test & Compare with this model selected.'],
          ['Folder button', 'Shows the model’s files in Finder or File Explorer.'],
          ['Trash button', 'Removes the model. See [Manage your models](help:models.manage).'],
        ],
      },
    ],
    terms: ['concept.params', 'concept.kv_cache', 'concept.context_length', 'concept.moe', 'concept.tied_embeddings', 'concept.bpw'],
  },
  {
    id: 'models.manage',
    title: 'Manage and remove models',
    summary: 'Find a model’s files, remove models you no longer need, and keep your workspace tidy.',
    body: [
      { h: 'Find the files' },
      { p: 'On a model page, click the folder button to show its files in Finder or File Explorer. Downloaded models live in your workspace under `models/`. Quantized outputs live under `outputs/`, and each row in **Quantized versions** has its own **Reveal** button.' },
      { h: 'Remove a model' },
      {
        steps: [
          'Open the model and click the trash button in the header.',
          'Read the confirmation. For a downloaded model it deletes the downloaded files; for an imported model your folder is not touched.',
          'Click **Remove**.',
        ],
      },
      { note: 'Quantized files you made from the model stay on disk when you remove it. Copy them somewhere safe first if you want to keep using them outside iQuantize.' },
      { h: 'Free up space' },
      {
        list: [
          'Remove originals you have finished with; you can always download them again.',
          'Delete old outputs from the `outputs/` folder in your workspace.',
          'Move the workspace to a larger drive in **Settings → Workspace**. Existing files are not moved, so move them yourself if you want them in the new location.',
        ],
      },
      { tip: 'Home shows free space on the workspace drive, and Environment’s System check warns when it drops to 30 GB or less.' },
    ],
    terms: ['concept.disk_space', 'settings.workspace'],
  },
];

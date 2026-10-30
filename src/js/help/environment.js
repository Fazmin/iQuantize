// Environment & settings: the toolchain, settings, accounts and where data lives.

export default [
  {
    id: 'setup.environment',
    title: 'Set up the tools',
    summary: 'One click installs a private Python, llama.cpp and an environment for each format. Nothing touches your system.',
    body: [
      { p: 'iQuantize relies on open-source tools to do the heavy lifting. Rather than asking you to install them, it downloads verified, pinned versions into its own folder. Your system Python, Homebrew and other tools are never touched.' },
      { h: 'Install everything' },
      {
        steps: [
          'Open **Environment** ([[G]] then [[E]]). The sidebar shows a yellow dot next to it while required tools are missing.',
          'Click **Install everything**. The button shows how many components are missing.',
          'Watch the install job at the top of the page. Components install one at a time, each with its own stages.',
          'When every row says **Installed**, you are ready.',
        ],
      },
      { p: 'You can also install components one at a time with the **Install** button on each row. Anything a component depends on is added automatically.' },
      { h: 'Components' },
      {
        table: {
          head: ['Component', 'Required', 'What it does'],
          rows: [
            ['[uv package manager](term:tc.uv)', 'Yes', 'Installs Python and every package below.'],
            ['[Python 3.12 (managed)](term:tc.python)', 'Yes', 'A private Python just for iQuantize.'],
            ['[llama.cpp tools](term:tc.llamacpp)', 'Yes', 'Quantizing, importance matrix, perplexity, benchmarks and the chat server for GGUF.'],
            ['[Hub & data tools](term:tc.env.core)', 'Yes', 'Hugging Face uploads, and calibration and evaluation datasets.'],
            ['[GGUF converter](term:tc.env.gguf)', 'Yes', 'Turns Hugging Face checkpoints into a full-precision GGUF.'],
            ['[MLX](term:tc.env.mlx)', 'Optional', 'MLX quantization and inference. Apple Silicon only.'],
            ['[ONNX Runtime GenAI](term:tc.env.onnx)', 'Optional', 'Builds and runs ONNX models.'],
          ],
        },
      },
      { p: 'Every download is checked against its published SHA-256 checksum. On NVIDIA machines (Windows and Linux), the ONNX environment uses the CUDA build automatically.' },
      { h: 'Choosing a llama.cpp build' },
      { p: 'On Windows and Linux there are several llama.cpp builds: NVIDIA CUDA 13 or 12, AMD ROCm, Vulkan (any GPU) and CPU only. The one that matches your hardware is marked **Recommended for this machine**, and **Install everything** always uses it. On a Mac there is one build: Metal on Apple Silicon, CPU on Intel.' },
      { p: 'To use a different build, pick it in the dropdown on the llama.cpp row and click **Install** (or **Reinstall**).' },
      { h: 'What your tools support' },
      { p: 'After installing, iQuantize asks each tool what it can do: which GGUF types and architectures llama.cpp supports, which MLX modes and methods mlx-lm offers, and which ONNX precisions and execution providers are available. The wizard only offers options your installed versions support. The table at the bottom of Environment lists them.' },
      { tip: 'Disk use: the required components take about 1 GB, and MLX and ONNX together add about 1.5 GB.' },
      { action: { label: 'Install everything', go: '#/environment?install=all', icon: 'package' } },
    ],
    terms: ['tc.uv', 'tc.python', 'tc.llamacpp', 'tc.accelerator', 'tc.probe'],
  },
  {
    id: 'setup.repair',
    title: 'Repair tools and run a system check',
    summary: 'Fix broken components, refresh what the tools support, and check your machine, disk and network.',
    body: [
      { h: 'Component status' },
      {
        defs: [
          ['Installed', 'Working. **Reinstall** downloads it again; the trash button removes it.'],
          ['Installing…', 'An install job is running.'],
          ['Not installed', 'Click **Install**.'],
          ['Needs repair', 'The app recorded it as installed but its files are missing. Click **Repair**.'],
          ['Not available here', 'Not supported on this machine, for example MLX without Apple Silicon.'],
        ],
      },
      { p: 'Removing a component asks first, and you can reinstall it any time. Python cannot be removed while other components depend on it.' },
      { h: 'Re-probe tools' },
      { p: 'Click **Re-probe tools** to ask every installed tool again what it supports. Do this if options seem to be missing in the wizard, or after repairing a component.' },
      { h: 'System check' },
      { p: 'The **System check** section shows a green tick or an amber warning for each of:' },
      {
        list: [
          'Operating system, CPU and threads, memory (warns below 8 GB) and accelerators.',
          'Free space in the workspace (warns at 30 GB or less: a 7–8B model needs roughly 30–40 GB).',
          'Whether huggingface.co, GitHub (tool downloads) and PyPI (Python packages) are reachable.',
          'Where secrets are stored (OS keychain or a private key file), each GPU with its memory, and on Linux the glibc version.',
        ],
      },
      { h: 'When an install fails' },
      {
        defs: [
          ['Checksum mismatch', 'The download was corrupted or interrupted. Try again.'],
          ['llama-quantize did not run correctly', 'Pick another llama.cpp build (CPU always works) or check that GPU drivers are installed.'],
          ['Unreachable sites in System check', 'Check your internet connection, VPN or proxy. Installs need GitHub and PyPI.'],
          ['An optional package could not be installed', 'Only the features that need it are turned off. The log names the package.'],
        ],
      },
    ],
    terms: ['tc.doctor', 'tc.probe', 'tc.accelerator'],
  },
  {
    id: 'setup.accounts',
    title: 'Connect your accounts',
    summary: 'Add a Hugging Face token for gated models and publishing, and an optional OpenAI key for writing model cards.',
    body: [
      { p: 'Both are optional and live in **Settings → Accounts**. iQuantize works fully offline for quantizing and testing models you already have.' },
      { h: 'Hugging Face' },
      { p: 'Needed to download [gated](term:concept.gated) or private models and to publish. A read token is enough for downloads; publishing needs write access. See [Get a Hugging Face token](help:publish.token).' },
      { p: 'Once saved, the token is checked each time you open Settings, showing who you are signed in as, the token’s role and your organizations. **Check** runs it again.' },
      { h: 'OpenAI' },
      { p: 'Only used by **Write with AI** in Docs. Create a key in your OpenAI account and click **Add key**. **Check** confirms the key works and how many of the featured models it can use.' },
      {
        defs: [
          ['[OpenAI-compatible API base URL](term:ai.base_url)', 'Where requests go. Default `https://api.openai.com/v1`. Point it at another compatible service or a local server; it must use https or be on localhost.'],
          ['Default model for documentation', 'The model Docs uses unless you pick another. Default GPT-5.6 Terra.'],
          ['[Default reasoning effort](term:ai.effort)', 'None, Low, Medium (default) or High.'],
          ['Quantized by (shown on model cards)', 'Your name or Hugging Face username. If blank, your Hugging Face username is used.'],
        ],
      },
      { h: 'How secrets are protected' },
      { p: 'Tokens and keys are encrypted (XChaCha20-Poly1305) in the app’s local database. The encryption key is kept in your operating system’s keychain, or in a private file readable only by you if no keychain is available. The interface never receives a secret back; it only shows the last four characters.' },
      { warn: 'Removing a token or key takes effect immediately, without asking.' },
    ],
    terms: ['hub.token', 'hub.token_role', 'ai.key', 'ai.base_url'],
  },
  {
    id: 'setup.settings',
    title: 'Settings reference',
    summary: 'Every setting, what it does and its default. Settings save as soon as you change them.',
    body: [
      { p: 'Open **Settings** from the sidebar, the iQuantize menu or [[G]] then [[S]]. There is no save button: each setting saves when you change it (text fields when you press Enter or click away).' },
      { h: 'Appearance' },
      { defs: [['[Theme](term:settings.theme)', 'System (follows your OS), Light or Dark. Also in the iQuantize menu and the work area header.']] },
      { h: 'Accounts' },
      { p: 'Hugging Face token, OpenAI key and the AI writing defaults. See [Connect your accounts](help:setup.accounts).' },
      { h: 'Workspace' },
      {
        defs: [
          ['[Workspace folder](term:settings.workspace)', 'Where models, outputs and caches are stored. Pick a large, fast drive. **Change…** picks a new folder; **Reveal** opens the current one.'],
          ['Keep intermediate files', 'On by default. The full-precision GGUF and importance matrix are cached so later runs on the same model skip those steps.'],
        ],
      },
      { warn: 'Changing the workspace does not move existing files. Models already in your library keep working from their old location; move other files yourself if you want them in the new folder.' },
      { h: 'Performance' },
      {
        defs: [
          ['[Heavy jobs at once](term:settings.concurrency)', '1–4, default 1. How many quantization or evaluation jobs run together. Each can use most of your memory, so 1 is safest. Takes effect after restarting the app.'],
          ['[CPU threads](term:settings.threads)', '0 means automatic. Sets how many threads llama.cpp uses to quantize, compute importance matrices and measure perplexity.'],
          ['[Notify me when long jobs finish](term:settings.notifications)', 'System notifications for quantization, evaluation, prompt suites and uploads when the app is in the background. On by default.'],
        ],
      },
      { h: 'About' },
      { p: 'The app version, your platform, the app data folder and how secrets are stored.' },
    ],
    terms: ['settings.workspace', 'settings.concurrency', 'settings.threads', 'settings.notifications', 'settings.theme'],
  },
  {
    id: 'setup.privacy',
    title: 'Where your data lives, and what leaves your computer',
    summary: 'The two folders iQuantize uses, how secrets are stored, and exactly when it talks to the internet.',
    body: [
      { h: 'Two folders' },
      {
        defs: [
          ['App data', 'The app’s database (settings, library, jobs, logs and encrypted secrets) and its private tools: uv, Python, llama.cpp and the per-format environments. Shown in **Settings → About**. On macOS it is in `~/Library/Application Support/com.iquantize.desktop`.'],
          ['Workspace', 'The bulky files: downloaded models, quantized outputs, the Hugging Face cache, calibration text, evaluation data and caches. Defaults to a `workspace` folder inside app data; change it in **Settings → Workspace**.'],
        ],
      },
      { p: 'Imported models stay where they are and are never copied.' },
      { h: 'What uses the network' },
      {
        table: {
          head: ['Service', 'When'],
          rows: [
            ['huggingface.co', 'Searching, model details, downloads, token checks, the WikiText-2 test text (first quality measurement only), calibration datasets, and publishing.'],
            ['GitHub', 'Installing uv and llama.cpp.'],
            ['PyPI', 'Installing Python packages.'],
            ['Your OpenAI API address', 'Only when you check your key or click a Write with AI action.'],
          ],
        },
      },
      { p: 'Chatting, prompt suites, speed tests, editing model cards and the number guard all run entirely on your computer. Hugging Face telemetry is turned off in the app’s Python environments.' },
      { h: 'What is shared when you publish' },
      { p: 'Your model card and `quantization_report.json`, which includes your hardware (OS, CPU, RAM, accelerators), tool versions, the commands run (with local paths replaced) and your “Quantized by” name. Publish privately first if you want to review it.' },
      { note: 'Secrets are encrypted at rest and never shown in full again. See [Connect your accounts](help:setup.accounts).' },
    ],
    terms: ['settings.workspace', 'hub.private', 'ai.provenance'],
  },
];

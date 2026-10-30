// Getting started: what the app is, a first run, and the interface.

export default [
  {
    id: 'start.overview',
    title: 'Welcome to iQuantize',
    summary: 'iQuantize makes large language models smaller and faster as GGUF, MLX or ONNX, and shows you exactly what changed along the way.',
    body: [
      { p: 'A language model is mostly billions of numbers called weights. [Quantization](term:concept.quantization) stores those numbers with fewer bits, so the model takes less disk and memory and usually runs faster. The trade-off is a small loss of accuracy. iQuantize helps you pick the right amount of compression for your hardware, then measures what it cost.' },
      { h: 'What you can do' },
      {
        defs: [
          ['**Models**', 'Download originals from Hugging Face or import a folder from disk. Each model gets an analysis of its architecture, memory needs and which formats can convert it.'],
          ['**Quantize**', 'A wizard turns your goal (device, memory, runtime, priority) into ranked recommendations with size, memory and quality estimates, then builds the files.'],
          ['**Jobs**', 'Every long task runs in the background. A live view shows each tensor being quantized, the shrinking file size and the logs.'],
          ['**Test & Compare**', 'Chat with the original and a quantized version side by side, run prompt suites, and measure perplexity, KL divergence and speed.'],
          ['**Docs**', 'Generate a model card from your real measurements, optionally refined by AI, with a guard that flags numbers you did not measure.'],
          ['**Publish**', 'Check, upload and verify a release on Hugging Face.'],
        ],
      },
      { h: 'The three formats' },
      {
        table: {
          head: ['Format', 'Best for', 'Runs in'],
          rows: [
            ['[GGUF](term:format.gguf)', 'Laptops, desktops and servers; the most widely supported local format', 'llama.cpp, LM Studio, Ollama and many others'],
            ['[MLX](term:format.mlx)', 'Apple Silicon Macs, using unified memory and the GPU', 'mlx-lm and MLX-based apps (macOS only)'],
            ['[ONNX](term:format.onnx)', 'Windows, cross-platform apps, the browser and mobile', 'ONNX Runtime GenAI, WebGPU, DirectML'],
          ],
        },
      },
      { p: 'Not sure which to choose? Read [Choose a format](help:quantize.formats).' },
      { h: 'How the app is organised' },
      { p: 'The workflow runs top to bottom in the sidebar: **Models → Quantize → Test & Compare → Docs → Publish**. **Jobs** tracks everything that runs in the background. **Environment** installs the tools the app needs, and **Learn** explains every term and option.' },
      { tip: 'Everything installs privately inside the app’s own folder. iQuantize never changes your system Python or other tools.' },
      { action: { label: 'Start the quick start', go: '#/help/start.quick-start', icon: 'rocket' } },
    ],
    terms: ['concept.quantization', 'concept.bpw', 'format.compare'],
  },
  {
    id: 'start.quick-start',
    title: 'Quick start: your first quantized model',
    summary: 'Go from nothing to a tested, quantized model in five steps. A small model such as SmolLM2-135M finishes in a few minutes.',
    body: [
      { p: 'This walkthrough uses a small model so each step is quick. The same steps work for any size; larger models simply take longer and need more disk space.' },
      {
        steps: [
          { title: 'Install the tools', text: 'Open **Environment** and click **Install everything for this machine**. The app downloads its own Python, llama.cpp and one environment per format. You only do this once. See [Set up the tools](help:setup.environment).' },
          { title: 'Add a model', text: 'Open **Models** and click **Add from Hugging Face**. Search for `SmolLM2-135M-Instruct`, pick it and start the download. Downloads resume if interrupted and are checked against Hugging Face’s checksums. See [Add a model from Hugging Face](help:models.add-hf).' },
          { title: 'Quantize it', text: 'Click **New quantization** (or press [[C]]). Choose the model, describe your goal, and accept the top recommendation. Click **Start quantization** and watch the live view as each tensor shrinks. See [Use the Quantize wizard](help:quantize.wizard).' },
          { title: 'Compare with the original', text: 'Open **Test & Compare**. Chat with the original and the quantized model side by side, then run a quality check to measure how far the quantized model drifts. See [Measure quality](help:test.quality).' },
          { title: 'Document and publish', text: 'Open **Docs** to generate a model card from your measurements, then **Publish** to upload it to Hugging Face. See [Publish to Hugging Face](help:publish.overview).' },
        ],
      },
      { note: 'Home shows the same five steps as a checklist and ticks each one off as you complete it, so you can always see what is left.' },
      { h: 'What to expect' },
      { list: ['The tools take about 1 GB of disk, or about 2.5 GB with MLX and ONNX as well.', 'You can leave any page while work runs. Jobs keep going in the background and a notification tells you when they finish.', 'Every option has an ⓘ explanation. Hover to preview it, click to pin it in the info panel.'] },
      { action: { label: 'Open Environment', go: '#/environment', icon: 'wrench' } },
    ],
    terms: ['concept.params', 'concept.disk_space'],
  },
  {
    id: 'start.tour',
    title: 'A tour of the interface',
    summary: 'The sidebar, the work area, the info panel and the command palette, and how they fit together.',
    body: [
      { h: 'Sidebar' },
      { p: 'The sidebar on the left is split into sections. Click a section heading to fold it away; the app remembers your choice.' },
      {
        defs: [
          ['**iQuantize ▾**', 'The app menu: Settings, Environment, theme (System, Light or Dark), the command palette, keyboard shortcuts and this guide.'],
          ['**New quantization** (pen button)', 'Starts the Quantize wizard from anywhere. Shortcut: [[C]].'],
          ['**Home, Jobs**', 'Your dashboard and the list of everything running or finished. A number next to Jobs shows how many are running.'],
          ['**Workflow**', 'Models, Quantize, Test & Compare, Docs and Publish, in the order you use them.'],
          ['**Toolkit**', 'Environment (the tools the app installs) and Settings. A yellow dot next to Environment means a required tool is missing.'],
          ['**Support**', 'This user guide and Learn, the glossary of every option and term.'],
          ['**? button**', 'At the bottom left: the guide, help for the current page, troubleshooting and shortcuts.'],
        ],
      },
      { p: 'Press [[[]] to collapse the sidebar to icons, or use the sidebar button at the top left. The back and forward arrows next to it move through pages you visited.' },
      { h: 'Work area' },
      { p: 'The page you are on sits in the main panel. Its header shows where you are: on a model or job page, click the section name in the breadcrumb (for example **Models**) to go back to the list. The buttons on the right of the header are:' },
      {
        defs: [
          ['**?**', 'Opens the article in this guide about the page you are on.'],
          ['**Theme**', 'Cycles between System, Light and Dark.'],
          ['**Info panel**', 'Shows or hides the info panel on the right. Shortcut: [[I]].'],
        ],
      },
      { h: 'Info everywhere' },
      { p: 'Almost every option has an explanation written in plain English. Hover an option, or the ⓘ next to it, to see a short description. Click ⓘ to pin the full entry in the info panel, with what it is, why it matters, what it is good for, when to avoid it, and related terms. The panel keeps a history, so its back arrow returns to the previous entry.' },
      { tip: 'Underlined terms in this guide work the same way: hover to preview, click to pin.' },
      { h: 'Command palette' },
      { p: 'Press [[⌘+K]] on macOS or [[Ctrl+K]] on Windows and Linux, or click **Search or jump to…** at the top. Type to jump to any page, run an action such as **Add a model from Hugging Face**, find an article in this guide, or look up a term. Use [[↑]] [[↓]] to move, [[↵]] to run and [[Esc]] to close.' },
      { h: 'Running jobs' },
      { p: 'When work is running, a **running** pill appears at the top right of the window. Click it to open Jobs. When a job finishes you get a message in the corner of the app, and for long tasks a system notification too (you can turn these off in Settings).' },
      { action: { label: 'See all keyboard shortcuts', go: '#/help/help.shortcuts', icon: 'command' } },
    ],
  },
];

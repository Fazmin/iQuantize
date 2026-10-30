// Test & Compare: arena, prompt suites, quality and speed.

export default [
  {
    id: 'test.overview',
    title: 'Test & Compare at a glance',
    summary: 'Put a quantized model next to its original and judge the difference three ways: by chatting, by scoring prompt suites, and by measuring quality and speed.',
    body: [
      { p: 'Open **Test & Compare** from the sidebar ([[G]] then [[T]]), from **Compare & test** on a finished job, or from **Test** next to any output. The page has three tabs:' },
      {
        defs: [
          ['**Arena**', 'Ask two models the same question and read their answers side by side. Best for a feel of the difference. See [Chat side by side](help:test.arena).'],
          ['**Prompt suites**', 'Run a fixed set of prompts with known answers and score them. Best for catching specific damage such as forgotten facts or broken code. See [Run prompt suites](help:test.suites).'],
          ['**Quality & speed**', 'Measure perplexity, KL divergence and tokens per second, and see every variant on a size-vs-quality chart. Best for choosing between variants. See [Measure quality](help:test.quality).'],
        ],
      },
      { h: 'What you can compare' },
      { p: 'Every output still on disk, plus an **original** for each quantization: the full-precision version the job made as a reference. For GGUF that is the full-precision GGUF from conversion; for MLX it is the original weights; for ONNX it is a full-precision build, made only when automatic evaluation was on.' },
      { h: 'Where models run' },
      { p: 'Everything runs locally on your machine. Nothing is sent anywhere, except the one-time download of the WikiText-2 test text for quality measurements.' },
      {
        table: {
          head: ['Format', 'Runtime', 'Needs'],
          rows: [
            ['GGUF', 'llama.cpp (`llama-server`, `llama-bench`, `llama-perplexity`)', 'llama.cpp tools'],
            ['MLX', 'mlx-lm', 'MLX (Apple Silicon)'],
            ['ONNX', 'ONNX Runtime GenAI', 'ONNX Runtime GenAI'],
          ],
        },
      },
      { p: 'Models stay loaded between questions so answers come quickly. A model unused for 10 minutes is unloaded automatically, and all of them stop when you close the window. Click **Stop all models** at the top of the page to free the memory right away.' },
      { note: 'Speed and quality measurements stop any loaded models first so they get the whole machine. The Arena reloads them the next time you send a prompt.' },
      { action: { label: 'Open Test & Compare', go: '#/test', icon: 'flask-conical' } },
    ],
    terms: ['eval.reference', 'eval.ppl', 'eval.kld'],
  },
  {
    id: 'test.arena',
    title: 'Chat side by side in the Arena',
    summary: 'Send the same prompt to two models, watch both answers stream in, see where they first differ, and vote for the better one.',
    body: [
      {
        steps: [
          { title: 'Pick two models', text: 'Choose **Model A** and **Model B**. By default A is your newest quantized output and B is its original in the same format, which is the most useful comparison. Each option shows its size and bits per weight.' },
          { title: 'Write a prompt', text: 'Type in the box at the bottom, or click an example such as “What is 17 × 23? Show your steps.” to fill it in.' },
          { title: 'Send', text: 'Click **Send to both** or press [[⌘+↵]] ([[Ctrl+↵]] on Windows and Linux). Each pane shows Loading model…, then Generating…, then Done. Click **Stop** to end early; the text so far is kept.' },
          { title: 'Compare', text: 'Under each answer you see the time to the first token, generation speed and token count. Turn on **Highlight differences** to mark words that differ and the first point where the answers part ways.' },
          { title: 'Vote', text: 'Choose **A is better**, **About the same** or **B is better**. You can change your vote.' },
        ],
      },
      { note: 'Each send is a single question. Earlier turns are not sent as context, so every comparison starts fresh.' },
      { h: 'Generation settings' },
      {
        defs: [
          ['[Temperature](term:eval.temperature)', 'Default **0 (deterministic)**: both models always pick their most likely word, so any difference comes from quantization. Raise it for more varied, creative answers.'],
          ['[Top-p](term:eval.top_p)', 'Limits sampling to the most likely words. Only matters above temperature 0.'],
          ['[Max new tokens](term:eval.max_tokens)', 'The longest answer to generate (16–4096, default 384).'],
          ['[Seed](term:eval.seed)', 'Makes sampling repeatable. Default 42.'],
          ['[System prompt](term:eval.system_prompt)', 'Instructions sent before your question. Default “You are a helpful assistant.” Leave it empty to send none.'],
          ['[Run one model at a time](term:eval.sequential)', 'Loads A, answers, unloads it, then does the same for B. Slower, but uses half the memory.'],
        ],
      },
      { tip: 'Keep temperature at 0 when using **Highlight differences**. With sampling on, answers differ even between identical models, so the first difference means nothing.' },
      { p: 'If both models together would not fit comfortably in free memory, the Arena switches to one at a time automatically and tells you.' },
      { h: 'Good prompts for spotting damage' },
      {
        list: [
          'Arithmetic with steps, such as multiplying two-digit numbers.',
          'Short code with an exact output.',
          'Less common facts (names, dates, places). Low-bit models tend to forget these first.',
          'Questions in a language other than English.',
          'Strict formatting, such as “answer in exactly three bullet points”.',
        ],
      },
    ],
    terms: ['eval.temperature', 'eval.divergence', 'eval.vote', 'eval.speed_tg', 'eval.ttft'],
  },
  {
    id: 'test.suites',
    title: 'Run prompt suites',
    summary: 'Score models on fixed sets of prompts with known answers, see how often they agree, and build suites from your own prompts.',
    body: [
      { p: 'A prompt suite runs the same prompts through each model at temperature 0 and scores the answers. It turns “seems fine” into a number you can compare.' },
      { h: 'Run a suite' },
      {
        steps: [
          'Open the **Prompt suites** tab and click a suite card to select it.',
          'Under **Models to test**, tick the models. The first two are ticked for you; pick a quantized output and its original to see how often they agree.',
          'Click **Run suite**. A job card shows progress, prompt by prompt. Models run one after another, so only one is in memory at a time.',
          'When it finishes, read the results below.',
        ],
      },
      { h: 'Built-in suites' },
      {
        table: {
          head: ['Suite', 'What it tests'],
          rows: [
            ['Code', 'Predicting exact program output and writing small functions. One wrong token changes the answer.'],
            ['Instruction following', 'Precise formatting and constraints: exact output, JSON, sorting, length, yes/no.'],
            ['Knowledge', 'Short factual questions, including less common facts that low-bit quantization tends to forget first.'],
            ['Multilingual', 'Questions and translations in several languages and scripts.'],
            ['Needle in a haystack', 'Finding planted facts in a long passage. Exposes long-context damage.'],
            ['Reasoning', 'Multi-step arithmetic, logic and date puzzles with short, checkable answers.'],
            ['Summarization', 'Summaries under strict limits, plus extraction questions.'],
          ],
        },
      },
      { h: 'Reading the results' },
      {
        defs: [
          ['% correct', 'The share of scored prompts where the expected answer appears in the model’s output (ignoring case, spacing and surrounding punctuation).'],
          ['[ROUGE-L](term:eval.rouge_l)', 'How much of the expected answer’s wording the output contains, from 0 to 1. Useful when answers are longer than one word.'],
          ['tok/s', 'Generation speed during the suite.'],
          ['Agreement with A', 'How similar the first two models’ answers are, averaged over prompts. High agreement between a quantized model and its original means quantization changed little.'],
        ],
      },
      { p: 'The table below lists every prompt with each model’s full answer and a **correct** or **wrong** badge, so you can see exactly what changed. The latest % correct also appears in the **Suite** column of Quality & speed.' },
      { note: 'Agreement compares only the first two models in a run. To compare more variants against the original, run them in pairs.' },
      { h: 'Make your own suite' },
      {
        steps: [
          'Click **New custom suite**.',
          'Give it a name.',
          'Enter one prompt per line. To enable correct/wrong scoring, add the expected answer after `||`, for example `What is the capital of Japan? || Tokyo`.',
          'Click **Save**. It appears with a **custom** badge.',
        ],
      },
      { tip: 'Prompts that look like your real use are the best test of all. Ten good ones beat a hundred generic ones.' },
      { warn: 'Each prompt must fit on one line, and custom suites cannot be edited or deleted yet. Create a new suite if you need changes.' },
    ],
    terms: ['eval.exact_match', 'eval.rouge_l', 'eval.temperature'],
  },
  {
    id: 'test.quality',
    title: 'Measure quality: perplexity and KL divergence',
    summary: 'Measure how far each quantized output drifts from its original on the same text, and what the numbers mean.',
    body: [
      { p: 'Chatting tells you how a model feels; measurements tell you how much it changed. iQuantize measures every output against its original **in the same runtime** on the same standard text, so the comparison is fair.' },
      { h: 'Run a measurement' },
      { p: 'If you left **Measure quality** on in the wizard, this already happened at the end of the job. To measure other outputs later:' },
      {
        steps: [
          'Open **Test & Compare → Quality & speed**. If you have several models, pick one at the top.',
          'Tick the quantized outputs you want to measure. They must all be the same format.',
          'Click **Measure quality vs original**. A job measures the original first, then each output.',
          'When it finishes, the table and chart update.',
        ],
      },
      { p: 'Measurements use 40 chunks of 512 tokens from the WikiText-2 test split. The text is downloaded from Hugging Face the first time, so that run needs an internet connection; after that it is reused.' },
      { warn: 'KL divergence needs both models in the same runtime, so you cannot measure a GGUF output against an MLX original. Compare within one format.' },
      { h: 'The numbers' },
      {
        defs: [
          ['[PPL (perplexity)](term:eval.ppl)', 'How surprised the model is by real text. Lower is better. A quantized model’s perplexity should be close to its original’s; small differences are hard to read on their own.'],
          ['[KLD (KL divergence)](term:eval.kld)', 'How far the quantized model’s predictions drift from the original’s at every position. **0 means identical.** The best single number for “how much did quantization change this model”.'],
          ['[Top-1 (same top token)](term:eval.top1)', 'How often both models rank the same next token first. 100% means identical output when picking the most likely word.'],
        ],
      },
      { h: 'Rules of thumb' },
      { p: 'KLD depends on the model and text, so compare variants with each other rather than against fixed limits. As a rough guide for GGUF:' },
      {
        table: {
          head: ['KLD', 'What it usually means'],
          rows: [
            ['below ~0.01', 'Very hard to tell apart from the original (typical of Q8_0 and Q6_K).'],
            ['~0.01 to 0.05', 'Small differences; fine for most uses (typical of Q5 and good Q4 builds).'],
            ['~0.05 to 0.15', 'Noticeable on harder tasks such as code, maths and rare facts.'],
            ['above ~0.15', 'Clear degradation. Check with the Arena and prompt suites before using it.'],
          ],
        },
      },
      { note: 'MLX and ONNX approximate KLD from the original’s 64 most likely tokens plus everything else, which can only under-estimate it. Their numbers are not directly comparable with GGUF’s full-vocabulary KLD.' },
      { tip: 'Small models (under about 3B parameters) lose more from quantization than large ones. Expect higher KLD at the same bit width.' },
      { action: { label: 'Open Quality & speed', go: '#/test?tab=Quality%20%26%20speed', icon: 'gauge' } },
    ],
    terms: ['eval.ppl', 'eval.kld', 'eval.top1', 'eval.kld_topk', 'eval.dataset.wikitext2', 'eval.reference'],
  },
  {
    id: 'test.speed',
    title: 'Measure speed',
    summary: 'Benchmark how fast each output reads prompts and generates text on this machine.',
    body: [
      {
        steps: [
          'Open **Test & Compare → Quality & speed**.',
          'Tick one or more outputs. Originals can be measured too, which shows how much faster quantization made the model.',
          'Click **Measure speed of selected**. Outputs are benchmarked one at a time.',
        ],
      },
      { p: 'Each benchmark processes a 512-token prompt and generates 128 tokens, three times. Results fill two columns:' },
      {
        defs: [
          ['[Prompt tok/s](term:eval.speed_pp)', 'How fast the model reads input. Matters for long prompts, documents and RAG.'],
          ['[Gen tok/s](term:eval.speed_tg)', 'How fast it writes. This is what you feel when chatting.'],
        ],
      },
      { tip: 'Generation speed is mostly limited by how fast memory can be read, so smaller files are usually faster. Close other heavy apps before benchmarking for steadier numbers.' },
      { note: 'Speeds are for this machine only. Publish them as such: the model card records the hardware they were measured on.' },
    ],
    terms: ['eval.speed_pp', 'eval.speed_tg', 'eval.ttft'],
  },
  {
    id: 'test.choose',
    title: 'Pick the best variant with the size-vs-quality chart',
    summary: 'Use the chart and table in Quality & speed to choose the variant with the best quality for the memory you have.',
    body: [
      { p: 'The **Size vs. quality** chart plots every measured quantized output: file size across, KL divergence up (on a log scale), coloured by format. **Lower-left is better**: smaller files that stay closer to the original.' },
      { p: 'The dashed line joins the [best trade-offs](term:eval.pareto) for each format. A variant on the line is not beaten by any other on both size and quality. A variant above the line is dominated: there is always a smaller or better choice.' },
      { h: 'A simple way to choose' },
      {
        steps: [
          'Decide the largest file you can afford (the Goal step’s memory budget helps).',
          'Among variants on the dashed line, pick the one with the lowest KLD within that size.',
          'Check it with a prompt suite that matches your use, for example Code for a coding model.',
          'Chat with it in the Arena for a final sanity check.',
        ],
      },
      { tip: 'Used **Explore** in the wizard? This chart is where it pays off: all five candidates appear here, measured the same way.' },
      { p: 'The table below the chart has every output with its size, bits per weight, PPL, KLD, top-1 agreement, prompt and generation speed, and the latest prompt-suite score. A dash means not measured yet.' },
      { note: 'Only outputs with a measured KLD appear on the chart. If it is empty, measure quality first.' },
    ],
    terms: ['eval.pareto', 'eval.kld', 'concept.bpw'],
  },
];

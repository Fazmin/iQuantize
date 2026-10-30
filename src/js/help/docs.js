// Docs: model cards, the editor, AI writing and the number guard.

export default [
  {
    id: 'docs.model-card',
    title: 'Create a model card',
    summary: 'Generate a Hugging Face README from exactly how your files were made and measured, with no AI needed.',
    body: [
      { p: 'A [model card](term:hub.model_card) is the `README.md` people read on Hugging Face before downloading. iQuantize writes one for you from the facts it recorded while building and testing your files, so every number in it is real.' },
      { h: 'Create one' },
      {
        steps: [
          { title: 'Open Docs', text: 'From the sidebar, or click **Write model card** on a finished job (its outputs are then selected for you).' },
          { title: 'Pick the outputs', text: 'Under **New model card**, tick the outputs the card should describe. They must all come from one model; usually you publish one format per repository.' },
          { title: 'Create', text: 'Click **Create model card**. The editor opens with a complete first draft.' },
        ],
      },
      { tip: 'Measure quality and speed before creating the card. The more you have measured, the more the card can say. If you measure later, use **Rebuild template** in the editor.' },
      { h: 'What the card contains' },
      {
        list: [
          '**Front matter** that Hugging Face reads: the base model, `base_model_relation: quantized`, licence, tags for each format, and who quantized it.',
          '**Files**: a table of every output with size, bits per weight, perplexity, KL divergence, same-top-token agreement and a “Use when” suggestion. The original is included as the reference.',
          '**How these files were made**: the method, recipe and tools.',
          '**Usage**: ready-to-run snippets for llama.cpp, Ollama, LM Studio, MLX and ONNX Runtime GenAI, as relevant.',
          '**Hardware used**, **Limitations**, **Reproduce** (with the exact commands, local paths removed) and **License**.',
        ],
      },
      { h: 'The provenance record' },
      { p: 'Behind the card is a [provenance](term:ai.provenance) record of everything that went into your files: the original model and its exact revision, each output’s recipe, checksums, measurements and tensor mix, the tool versions, your hardware, and the commands that were run. It is uploaded alongside the card as `quantization_report.json`, so anyone can check how the files were made.' },
      { note: 'The “quantized by” name comes from **Settings → Accounts → Quantized by**, or your Hugging Face username if that is blank.' },
      { h: 'Managing cards' },
      { p: 'The **Documents** list shows each card with when it was last edited and whether it is a **Draft** or **Published** (with the repository). Click one to open it, or use the trash button to delete it along with its history.' },
    ],
    terms: ['hub.model_card', 'ai.provenance', 'hub.base_model_relation', 'hub.license'],
  },
  {
    id: 'docs.editor',
    title: 'Edit, preview and version history',
    summary: 'Edit the Markdown with a live Hugging Face preview, rebuild from new measurements, and restore any earlier version.',
    body: [
      { p: 'The editor has the Markdown source on the left and a preview on the right, rendered the way Hugging Face shows it. The front matter appears as a separate block at the top of the preview.' },
      { h: 'Saving' },
      { p: 'Changes save automatically a moment after you stop typing; the status next to the title shows **Editing…** and then **Saved**. There is no save button.' },
      { h: 'Rebuild template' },
      { p: '**Rebuild template** refreshes the provenance with your latest measurements and replaces the whole document with a fresh template. Use it after measuring more outputs.' },
      { warn: 'Rebuilding replaces everything in the editor, including your own edits, without asking. Your previous text is kept in version history, so you can copy parts back.' },
      { h: 'Version history' },
      { p: 'Click the history button to see up to 100 earlier versions, labelled **Generated template**, **AI (model)** or **Edited**, with when they were saved and their length. **Restore** brings one back as a new version, so nothing is lost.' },
      { h: 'Getting the text out' },
      { p: 'Click **Publish** to save and go straight to the Publish page with this card selected. To use the card elsewhere, select all the text in the source pane and copy it.' },
      { tip: 'Usage snippets contain the placeholder `<your-username>/<repo-name>`. Leave it in: publishing replaces it with your real repository name.' },
    ],
    terms: ['hub.model_card'],
  },
  {
    id: 'docs.ai',
    title: 'Write with AI',
    summary: 'Use an OpenAI model to draft, explain, tighten or extend your card, optionally comparing up to three models at once.',
    body: [
      { p: 'AI writing is optional. It needs an OpenAI API key (or another OpenAI-compatible service) in **Settings → Accounts**. See [Connect your accounts](help:setup.accounts).' },
      { h: 'Actions' },
      { p: 'The **Write with AI** panel under the editor offers:' },
      {
        defs: [
          ['[Draft the full card](term:ai.action.draft)', 'A complete, polished card built on the template, adding a “Which file should I pick?” section. **Use this draft** replaces the whole document.'],
          ['[Explain for beginners](term:ai.action.beginner)', 'Adds a plain-English section on how the model was quantized at the end of the card.'],
          ['[Add an FAQ](term:ai.action.faq)', 'Adds five to seven questions and answers: which file to pick, memory needs, how quality was measured, how to run it, licence.'],
          ['[Rewrite selection](term:ai.action.rewrite)', 'Clearer wording for the text you selected, same meaning.'],
          ['[Tighten selection](term:ai.action.tighten)', 'About 40% shorter.'],
          ['[Expand selection](term:ai.action.expand)', 'More explanation, grounded in your data.'],
          ['[Add a changelog](term:ai.action.changelog)', 'Adds a short entry on what was produced and with which tools.'],
        ],
      },
      { p: 'For the selection actions, select text in the source pane first. Results appear in a box with the number of tokens and an estimated cost; click **Insert** (or **Use this draft**) to apply them. Every insert is saved as an **AI (model)** version.' },
      { warn: 'Do not edit the document between starting a selection action and inserting its result, or the text may land in the wrong place.' },
      { h: 'Model and effort' },
      {
        defs: [
          ['Model', 'Defaults to your choice in Settings (GPT-5.6 Terra unless changed). Prices per million tokens are shown where known. Click the refresh button to check which models your key can use.'],
          ['[Effort](term:ai.effort)', 'How much the model reasons before writing: none, low, medium or high. Higher is slower and costs more.'],
        ],
      },
      { h: 'Compare models' },
      { p: 'Click **Compare models** and tick up to two extra models. Every action then runs on up to three models in parallel, each in its own result box, so you can pick the best wording or merge by hand. The choice lasts until you leave the editor.' },
      { h: 'Staying accurate' },
      { p: 'Every action is told to use only your provenance data and never invent numbers. As a safety net, the [number guard](help:docs.guard) checks AI text for figures that are not in your measurements.' },
      { h: 'What is sent' },
      { p: 'Requests go straight from your computer to the API address in Settings. Each one includes the instructions, your provenance record (including hardware, checksums and commands), the template, the current document and any selected text. Nothing else from your machine is sent, and nothing is sent unless you click an action.' },
    ],
    terms: ['ai.key', 'ai.effort', 'ai.multi_draft', 'ai.guard', 'ai.cost'],
  },
  {
    id: 'docs.guard',
    title: 'The number guard',
    summary: 'How iQuantize flags figures in a card that do not come from your own measurements.',
    body: [
      { p: 'Model cards are full of numbers: sizes, perplexity, speeds. A wrong one misleads everyone who downloads your model. The [number guard](term:ai.guard) checks each number against the data iQuantize recorded.' },
      { h: 'When it runs' },
      {
        list: [
          'When you open a card in the editor.',
          'After you insert any AI result.',
          'When you click **Check numbers** on an AI result, before inserting it.',
        ],
      },
      { note: 'It does not re-run while you type by hand. Reopen the card to check your own edits.' },
      { h: 'Reading the result' },
      { p: '“Every number traces back to your measurements.” means everything checks out. Otherwise you see how many numbers were not found, with up to eight of them shown in context. Check each one before publishing; edit or remove any that are wrong.' },
      { p: 'A flagged number is not necessarily wrong: it might be a rounded value, a figure from the original model’s own card, or general knowledge. The guard simply could not find it in your data.' },
      { h: 'What it ignores' },
      {
        list: [
          'Whole numbers up to 12, and years from 1990 to 2100.',
          'Anything inside code blocks.',
          'Numbers that match your data in another form, such as a percentage or with a unit like `105.5 MB`.',
        ],
      },
    ],
    terms: ['ai.guard', 'ai.provenance'],
  },
];

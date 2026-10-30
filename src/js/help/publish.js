// Publish: tokens, the publish flow, and what lands in the repository.

export default [
  {
    id: 'publish.token',
    title: 'Get a Hugging Face token for publishing',
    summary: 'Create a token with write access on huggingface.co and add it to iQuantize, where it is stored encrypted.',
    body: [
      { p: 'Publishing needs a Hugging Face [access token](term:hub.token) that can write. A read token is enough for downloading gated models but cannot upload.' },
      {
        steps: [
          { title: 'Create the token', text: 'Sign in at huggingface.co and open **Settings → Access Tokens**. Create a token with the **Write** role. A fine-grained token also works if it has write permission for the account or organization you will publish to.' },
          { title: 'Add it to iQuantize', text: 'Open **Settings → Accounts** and click **Add token** next to Hugging Face. Paste the token (it starts with `hf_`) and click **Save**.' },
          { title: 'Check it', text: 'iQuantize checks the token straight away and shows who you are signed in as, the token’s role and your organizations.' },
        ],
      },
      { p: 'The Publish page shows **Can publish** for write, fine-grained and admin tokens, and **Read-only token** otherwise.' },
      { note: 'The token is encrypted on your computer and is never shown again, not even to the app’s own interface. To change it, click **Replace**; to remove it, click the trash button.' },
      { action: { label: 'Open Settings', go: '#/settings', icon: 'settings' } },
    ],
    terms: ['hub.token', 'hub.token_role', 'hub.namespace'],
  },
  {
    id: 'publish.overview',
    title: 'Publish to Hugging Face',
    summary: 'Check the plan, upload your files and model card, and let iQuantize verify that everything arrived intact.',
    body: [
      { h: 'Before you start' },
      {
        list: [
          'A model card in **Docs**. The card decides which files are uploaded.',
          'A Hugging Face token with write access. See [Get a Hugging Face token](help:publish.token).',
          '**Hub & data tools** installed in Environment.',
          'The output files still on disk, and an internet connection.',
        ],
      },
      { h: 'Publish' },
      {
        steps: [
          { title: 'Pick the card', text: 'Choose it under **Model card to publish**. Each option says where it was last published, if anywhere.' },
          { title: 'Choose where it goes', text: 'Pick the **Owner**: your account or one of your organizations. The **Repository name** is suggested from the model and formats, such as `Qwen3-8B-GGUF`; change it if you like.' },
          { title: 'Set visibility and message', text: '**Private repository** is on by default, so only you can see it until you are ready. Edit the **Commit message** if you want.' },
          { title: 'Check before publishing', text: 'iQuantize lists every file it will upload with sizes, and says whether this is a **New repository** or **Updates existing repository**. Any problems appear as warnings.' },
          { title: 'Publish', text: 'Click **Publish to owner/name**. A job prepares the files, uploads them and verifies the upload.' },
        ],
      },
      { p: 'When it finishes you see **Published!** with a link to open the repository. The card is marked as published in Docs and the repository appears in the **Published** list.' },
      { h: 'Checks and warnings' },
      {
        table: {
          head: ['Warning', 'Blocks publishing?', 'What to do'],
          rows: [
            ['Your token looks read-only', 'Yes', 'Replace it with a write token in Settings.'],
            ['You are not a member of “owner”', 'Yes', 'Choose your username or one of your organizations.'],
            ['Files exceed the 50 GB per-file limit', 'Yes', 'Quantize again; GGUF files over the split size are split automatically.'],
            ['Llama licence', 'No', 'Llama licences require derivative names to start with “Llama” and the licence to be included.'],
            ['Gemma terms', 'No', 'Keep the licence and usage policy links in the card.'],
          ],
        },
      },
      { h: 'Verification' },
      { p: 'After uploading, iQuantize reads the repository’s file list back from Hugging Face and checks that every model file has the right size. If something does not match, the job fails with the list of files; publish again and the upload resumes where it stopped.' },
      { tip: 'Large uploads use Hugging Face’s Xet storage and resume if interrupted, so a dropped connection costs little.' },
      { action: { label: 'Open Publish', go: '#/publish', icon: 'cloud-upload' } },
    ],
    terms: ['hub.namespace', 'hub.repo_name', 'hub.private', 'hub.file_limit', 'hub.xet', 'hub.license'],
  },
  {
    id: 'publish.contents',
    title: 'What gets uploaded',
    summary: 'The files, folder layout and extras that end up in your Hugging Face repository.',
    body: [
      {
        defs: [
          ['`README.md`', 'Your model card, with the `<your-username>/<repo-name>` placeholders replaced by the real repository.'],
          ['`quantization_report.json`', 'The full provenance record: recipe, tool versions, measurements, checksums, hardware and commands (with local paths removed).'],
          ['GGUF files', 'Every file, including all shards of split files, at the top of the repository.'],
          ['MLX and ONNX folders', 'With one output, its folder contents go at the top of the repository. With several, each goes in a sub-folder named after its variant.'],
        ],
      },
      { h: 'Updating a repository' },
      { p: 'Publishing to a repository that already exists adds or replaces files in a new commit. The plan shows **Updates existing repository** so you know before you start. Changing the **Private** toggle does not change the visibility of an existing repository; do that on huggingface.co.' },
      { note: 'For uploads over 20 GB, some versions of the Hugging Face tools use a resumable mode that ignores the commit message. The log says when this happens.' },
      { h: 'Privacy' },
      { p: '`quantization_report.json` includes your OS, CPU, RAM and accelerators, and the name you set as **Quantized by**. Paths on your computer are replaced with placeholders such as `<workspace>` and `~`.' },
      { tip: 'Publish privately first, look over the repository on huggingface.co, then make it public there.' },
    ],
    terms: ['hub.update_existing', 'hub.commit_message', 'hub.private', 'ai.provenance'],
  },
];

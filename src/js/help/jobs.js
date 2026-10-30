// Jobs: the live view, the jobs list, and what to do when something fails.

export default [
  {
    id: 'jobs.live-view',
    title: 'Read the live view',
    summary: 'A quantization job’s page shows every stage, every tensor as it is quantized, the shrinking size, system load, logs and finally the results.',
    body: [
      { p: 'Starting a quantization opens its job page. You can also open any job from **Jobs**, the **running** pill at the top of the window, or the **Open** button on a notification. Leaving the page does not stop the job.' },
      { p: 'The header shows the job’s title and status, a link to the model, when it started and how long it took. While it runs, **Cancel** stops it.' },
      { h: 'Pipeline' },
      { p: 'One node per stage, in order. Each shows its duration, **In progress**, **Skipped**, or **Reused from cache** when a saved result was used. A GGUF job, for example, runs:' },
      {
        steps: [
          { title: 'Convert to GGUF', text: 'Turns the original weights into a full-precision GGUF file. Cached for later runs.' },
          { title: 'Prepare calibration text, Compute importance matrix', text: 'Only when the importance matrix is on.' },
          { title: 'Quantize (one stage per type)', text: 'For example **Quantize Q4_K_M**, once for each type you chose.' },
          { title: 'Measure the original, then Evaluate each type', text: 'Only with automatic evaluation on.' },
          { title: 'Index and checksum outputs', text: 'Records sizes, the tensor mix and SHA-256 checksums.' },
        ],
      },
      { p: 'MLX jobs run **Quantize**, then the evaluation stages, then **Index outputs**. ONNX jobs run **Build** for each variant, then **Build full-precision reference** and the evaluation stages, then **Register outputs**.' },
      { p: 'If a stage fails, a red box under the pipeline shows the error and a hint. You can select and copy the text.' },
      { h: 'Model X-ray' },
      { p: 'The tensor map from the model page, brought to life. Each column is a transformer block (**emb** is the embeddings, **out** the output head) and each row is a kind of tensor such as attention or feed-forward weights.' },
      {
        list: [
          'Cells start faded in their original precision and fill from the bottom with their new bit-width colour as they are quantized. The cell being worked on pulses.',
          'The legend runs from **≤1.6-bit** to **16-bit**, so you can see at a glance where a mixed recipe spent more bits.',
          'Hover a cell for the tensor name, its parameters and shape, and its size before and after.',
          'The line above the map says what is happening now, for example `blk.3.attn_v → Q6_K · tensor 12 of 291`.',
        ],
      },
      { note: 'GGUF and standard MLX update tensor by tensor; ONNX updates a whole block at once. MLX’s calibrated methods (AWQ, GPTQ, DWQ, Dynamic) do not report individual tensors, so the map may not fill for them.' },
      { h: 'Size and precision mix' },
      { p: 'The **Size** card projects the final file size against the original and shows how many times smaller it is and the [bits per weight](term:concept.bpw) so far, plus how many tensors are done and, while quantizing GGUF, roughly how long the step has left. **Precision mix** shows what share of the model’s parameters ended up at each type.' },
      { h: 'Chart, system and log' },
      {
        defs: [
          ['Chart', 'Appears when the job reports per-chunk measurements, such as perplexity while computing the importance matrix or during evaluation. It only shows points received while the page is open.'],
          ['System', 'CPU use, memory used by the tools, system RAM and free disk space, updated every second and a half.'],
          ['Log', 'Every command the job runs (`$ …`), each stage (`▸ …`), results (`✓ …`), warnings (`⚠ …`) and errors (`✖ …`). It follows new output unless you scroll up. **Copy** copies it all.'],
        ],
      },
      { h: 'Results' },
      { p: 'When a quantization job finishes, the **Results** table lists each output next to the **reference** (the full-precision version measured the same way):' },
      {
        defs: [
          ['Size, Bits/weight', 'The real file size and average bits per weight.'],
          ['[Perplexity](term:eval.ppl)', 'Lower is better. The percentage shows the increase over the reference.'],
          ['[KL divergence](term:eval.kld)', 'How far the output’s predictions drift from the reference. 0 means identical.'],
          ['[Same top token](term:eval.top1)', 'How often both pick the same most likely next token.'],
        ],
      },
      { p: 'Each row has **Reveal** (show the file) and **Test**. **Show the final tensor map for:** redraws the X-ray for any variant. Two buttons take you to the next steps: **Compare & test** opens Test & Compare with this output against the original, and **Write model card** opens Docs with these outputs selected.' },
      { tip: 'Not sure what the numbers mean? See [Measure quality](help:test.quality).' },
    ],
    terms: ['concept.bpw', 'concept.mixed_precision', 'eval.ppl', 'eval.kld', 'eval.top1', 'eval.reference'],
  },
  {
    id: 'jobs.list',
    title: 'The Jobs list, statuses and notifications',
    summary: 'Everything iQuantize runs in the background in one list, with filters, live progress and notifications when work finishes.',
    body: [
      { p: 'Downloads, installs, quantizations, evaluations, prompt suites and uploads all run as **jobs** in the background. You can keep using the app, close the page, or open another one while they work.' },
      { h: 'The list' },
      { p: 'Open **Jobs** in the sidebar ([[G]] then [[J]]). Filter with the pills at the top: **All**, **Quantize**, **Evaluate** (including prompt suites), **Downloads**, **Uploads** and **Installs**. Each row shows the status, title, current stage and progress while running, the first line of the error if it failed, the kind of job, and how long it took. Click a row for its full page.' },
      {
        defs: [
          ['Running', 'Working now.'],
          ['Queued', 'Waiting for a free slot (shown as “Waiting for a free slot…”). See below.'],
          ['Done', 'Finished successfully.'],
          ['Failed', 'Stopped with an error. Open it for the message, hint and log.'],
          ['Cancelled', 'You stopped it.'],
        ],
      },
      { h: 'Why a job is queued' },
      { p: 'Quantization and evaluation are **heavy**: they can use most of your memory. By default only one heavy job runs at a time and others wait their turn, which is the safest setting. You can raise **Heavy jobs at once** to 4 in **Settings → Performance** (restart the app afterwards). Downloads and uploads are never held back, and installs always run one at a time.' },
      { h: 'Keeping track' },
      {
        list: [
          'A **running** pill at the top right and a count next to **Jobs** in the sidebar show how many jobs are running or queued.',
          'When a job finishes or fails, a message appears in the corner with **Open** or **Details**.',
          'For quantization, evaluation, prompt suites and uploads, you also get a system notification when the app is in the background. Turn these off with **Notify me when long jobs finish** in Settings.',
        ],
      },
      { h: 'Deleting a job record' },
      { p: 'On a finished job’s page, the trash button deletes the job’s record and log. **Outputs on disk are kept.** Cancel a running job before deleting it.' },
      { action: { label: 'Open Jobs', go: '#/jobs', icon: 'activity' } },
    ],
    terms: ['settings.concurrency', 'settings.notifications'],
  },
  {
    id: 'jobs.failures',
    title: 'Cancel, failures and running again',
    summary: 'How to stop a job, read why one failed, and run it again without repeating slow steps.',
    body: [
      { h: 'Cancelling' },
      { p: 'Click **Cancel** on a job card or job page. The job stops at once (along with any tools it started) and its remaining stages are marked cancelled. Queued jobs can be cancelled too. Outputs that finished before you cancelled are kept.' },
      { h: 'When a job fails' },
      {
        steps: [
          { title: 'Read the message and hint', text: 'Shown in red under the pipeline. Tool failures say which step failed, its exit code and the last lines of its output.' },
          { title: 'Check the log', text: 'The full log is on the same page. Search it for the first `✖` or `error` line.' },
          { title: 'Fix the cause', text: 'Common fixes are below and in [Troubleshooting](help:help.problems).' },
          { title: 'Run it again', text: 'There is no retry button: start the wizard again with the same model. Cached steps are skipped, so a re-run is usually much faster.' },
        ],
      },
      {
        table: {
          head: ['Message', 'What to do'],
          rows: [
            ['“Converting needs about X free; only Y available”', 'Free disk space or move the workspace to a larger drive in Settings.'],
            ['“llama.cpp cannot convert this architecture yet.”', 'Try MLX or ONNX, or check Environment for a newer llama.cpp.'],
            ['“Q2_K_S needs an importance matrix” (or another type)', 'Turn the importance matrix on in Options.'],
            ['“The ONNX Runtime GenAI builder does not support this architecture”', 'Switch the ONNX engine to Optimum, or use GGUF or MLX.'],
            ['“… failed (exit code N)”', 'Read the log. If a tool seems broken, use **Repair** on its row in Environment.'],
            ['“Choose a calibration text file”', 'You picked **My own text** without a file. Choose one in Calibration & tests.'],
            ['“Interrupted: the app was closed while this job was running.”', 'Run it again. Jobs cannot survive the app closing.'],
          ],
        },
      },
      { warn: 'Quitting iQuantize stops running jobs. Downloads resume from where they stopped; other jobs start again (with cached steps reused).' },
    ],
  },
];

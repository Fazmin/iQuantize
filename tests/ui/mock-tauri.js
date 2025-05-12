// Mocked Tauri bridge for the UI harness. Responses mirror the Rust command shapes.
(function () {
  const now = Date.now();
  const listeners = {};
  const platform = {
    os: 'macos', arch: 'aarch64', os_version: 'macOS 27.0', cpu_brand: 'Apple M3 Pro', cores: 12, total_ram: 24 * 1024 ** 3,
    apple_silicon: true, mlx_supported: true, accelerators: ['metal', 'cpu'], gpus: [{ vendor: 'apple', name: 'Apple M3 Pro', vram_bytes: 24 * 1024 ** 3 }], detected: true,
  };
  const settings = {
    theme: 'system', workspace: '/Users/demo/Library/Application Support/com.iquantize.desktop/workspace', concurrency: '1', threads: '0',
    keep_intermediates: 'true', notifications: 'true', accelerator: 'auto', ai_base_url: 'https://api.openai.com/v1', ai_default_model: 'gpt-5.6-terra',
    ai_effort: 'medium', hf_username: '', sidebar_collapsed: 'false', inspector_open: 'false', onboarded: '', quantized_by: '',
  };
  const fixtures = (window.__MOCK_FIXTURES = window.__MOCK_FIXTURES || {});
  const base = {
    app_info_default: () => ({
      version: '0.1.0', platform, memory_budget: 17.3e9,
      paths: { data: '/Users/demo/Library/Application Support/com.iquantize.desktop', workspace: settings.workspace, models: settings.workspace + '/models', outputs: settings.workspace + '/outputs' },
      secrets_backend: { kind: 'os-keychain', warning: null }, first_run: true, active_jobs: [],
    }),
    settings_get: () => settings,
    settings_set: ({ key, value }) => { settings[key] = value; return null; },
    set_theme: () => null,
    dev_script: () => null,
    dev_log: () => null,
    dev_dump: () => null,
    notify: () => null,
    doc_render: ({ markdown }) => '<pre class="frontmatter">base_model: demo</pre>' + markdown.replace(/^---[\s\S]*?---\n/, '').split('\n\n').map((p) => p.startsWith('#') ? `<h2>${p.replace(/^#+\s*/, '')}</h2>` : p.startsWith('|') ? `<table><tr><td>${p.slice(0, 120)}</td></tr></table>` : `<p>${p.slice(0, 400)}</p>`).join(''),
    doc_guard: () => [{ value: '71.3', context: 'scores 71.3 on MMLU', start: 0 }],
    doc_versions: () => [],
    doc_save: () => null,
    publish_prepare: () => ({ user: { name: 'demo-user', can_write: true }, repo: { exists: false }, files: [{ path: 'SmolLM2-135M-Instruct-Q4_K_M.gguf', bytes: 105500000 }], total_bytes: 105500000, warnings: [], blocked: false }),
    runners_list: () => [],
    // Cursor-paged like the Hub: the cursor is just the next offset here.
    hub_search: ({ query = '', limit = 50, cursor }) => {
      const all = HUB.filter((m) => !query || m.id.toLowerCase().includes(query.toLowerCase()));
      const start = Number(cursor || 0);
      const end = start + limit;
      return { items: all.slice(start, end), cursor: end < all.length ? String(end) : null };
    },
    hub_model_info: ({ repoId }) => {
      const m = HUB.find((x) => x.id === repoId) || HUB[0];
      const arch = m.arch || { architecture: 'LlamaForCausalLM', layers: 30, context_length: 8192, torch_dtype: 'bfloat16' };
      const q = m.already_quantized;
      return {
        repo_id: repoId, revision: '9d943d19bc7a5e2f0000', gated: m.gated, license: m.license, params: m.params, downloads: m.downloads, likes: m.likes,
        last_modified: m.last_modified, base_model: q ? 'Qwen/Qwen3-4B' : null, chat_template: true,
        arch: { ...arch, quantization: q ? 'gguf' : null },
        download_bytes: m.params * 2.02, download_files: Array.from({ length: m.params > 3e9 ? 9 : 6 }, (_, i) => i), has_safetensors: !q,
        compat: q
          ? { gguf: { status: 'warn', reason: 'This checkpoint is already quantized (gguf). Start from the original full-precision model for best results.' }, mlx: { status: 'warn', reason: 'Already quantized.' }, onnx: { status: 'no', reason: 'No .safetensors weights found.' } }
          : { gguf: { status: 'yes', reason: `llama.cpp's converter supports ${arch.architecture}.` }, mlx: { status: 'yes', reason: `mlx-lm has a native implementation of "${arch.architecture.replace(/ForCausalLM/, '').toLowerCase()}".` }, onnx: m.id.includes('gemma') ? { status: 'warn', reason: `The GenAI builder does not support ${arch.architecture}; the generic exporter may still work.` } : { status: 'yes', reason: `The ONNX Runtime GenAI model builder supports ${arch.architecture}.` } },
      };
    },
    app_ready: () => null,
    jobs_list: () => [],
    secrets_status: () => ({ items: [{ name: 'hf_token', hint: '••••a1b2', updated_at: now }], backend: { kind: 'os-keychain', warning: null } }),
    hf_whoami: () => ({ name: 'demo-user', role: 'write', orgs: ['demo-org'] }),
    ai_models: () => ({
      live_count: 0,
      featured: [
        { id: 'gpt-6.1-sol', family: 'gpt-6.1', label: 'GPT-6.1 Sol', available: null },
        { id: 'gpt-5.6-terra', family: 'gpt-5.6', label: 'GPT-5.6 Terra', available: null },
        { id: 'gpt-5.4', family: 'gpt-5.4', label: 'GPT-5.4', available: null },
      ],
    }),
    system_stats: () => ({ cpu: 37.5, ram_used: 14.2e9, ram_total: 24 * 1024 ** 3, disk_free: 159e9, children_rss: 3.1e9 }),
  };
  const day = 86400000;
  const iso = (d) => new Date(now - d * day).toISOString();
  const HUB = [
    { id: 'Qwen/Qwen3-4B', downloads: 4210000, likes: 512, params: 4.02e9, license: 'apache-2.0', gated: false, last_modified: iso(40), arch: { architecture: 'Qwen3ForCausalLM', layers: 36, context_length: 40960, torch_dtype: 'bfloat16' } },
    { id: 'meta-llama/Llama-3.2-1B-Instruct', downloads: 3120000, likes: 1104, params: 1.24e9, license: 'llama3.2', gated: true, last_modified: iso(210), arch: { architecture: 'LlamaForCausalLM', layers: 16, context_length: 131072, torch_dtype: 'bfloat16' } },
    { id: 'Qwen/Qwen2.5-0.5B-Instruct', downloads: 2380000, likes: 371, params: 0.49e9, license: 'apache-2.0', gated: false, last_modified: iso(300), arch: { architecture: 'Qwen2ForCausalLM', layers: 24, context_length: 32768, torch_dtype: 'bfloat16' } },
    { id: 'HuggingFaceTB/SmolLM2-135M-Instruct', downloads: 1610000, likes: 248, params: 0.135e9, license: 'apache-2.0', gated: false, last_modified: iso(120) },
    { id: 'google/gemma-3-1b-it', downloads: 1450000, likes: 640, params: 1.0e9, license: 'gemma', gated: true, last_modified: iso(90), arch: { architecture: 'Gemma3ForCausalLM', layers: 26, context_length: 32768, torch_dtype: 'bfloat16' } },
    { id: 'mistralai/Mistral-7B-Instruct-v0.3', downloads: 1290000, likes: 2010, params: 7.25e9, license: 'apache-2.0', gated: false, last_modified: iso(400), arch: { architecture: 'MistralForCausalLM', layers: 32, context_length: 32768, torch_dtype: 'bfloat16' } },
    { id: 'bartowski/Qwen3-4B-GGUF', downloads: 980000, likes: 88, params: 4.02e9, license: 'apache-2.0', gated: false, last_modified: iso(38), already_quantized: true },
    { id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', downloads: 870000, likes: 690, params: 1.71e9, license: 'apache-2.0', gated: false, last_modified: iso(150) },
    { id: 'microsoft/Phi-4-mini-instruct', downloads: 640000, likes: 530, params: 3.84e9, license: 'mit', gated: false, last_modified: iso(5), arch: { architecture: 'Phi3ForCausalLM', layers: 32, context_length: 131072, torch_dtype: 'bfloat16' } },
    { id: 'Qwen/Qwen3-14B', downloads: 520000, likes: 260, params: 14.8e9, license: 'apache-2.0', gated: false, last_modified: iso(45), arch: { architecture: 'Qwen3ForCausalLM', layers: 40, context_length: 40960, torch_dtype: 'bfloat16' } },
    { id: 'mlx-community/Qwen3-4B-4bit', downloads: 310000, likes: 41, params: 0.63e9, license: 'apache-2.0', gated: false, last_modified: iso(39), already_quantized: true },
  ];
  // A long tail so paging and the 100-result cap can be exercised.
  for (let i = 1; i <= 140; i++) {
    HUB.push({ id: `community-${i % 7}/tiny-chat-${i}`, downloads: Math.round(300000 / i), likes: (i * 7) % 90, params: [0.36e9, 1.1e9, 2.7e9, 7.6e9, 32e9][i % 5], license: 'apache-2.0', gated: false, last_modified: iso(i * 3) });
  }
  const D = window.__MOCK_DATA || {};
  const fromData = {
    quant_estimate: ({ recipe }) => D[`quant_estimate_${recipe.format}`],
    artifact_tensors: () => (D.model_tensors || []).map((t, i) => { const norm = /norm/.test(t.name); const bits = norm ? 32 : /v_proj|down_proj/.test(t.name) && i % 3 === 0 ? 6.5625 : /embed/.test(t.name) ? 8.5 : 5.5; return { ...t, dtype: norm ? 'F32' : bits > 8 ? 'Q8_0' : bits > 6 ? 'Q6_K' : 'Q5_0', bits, bytes: Math.round((t.n_elements * bits) / 8) }; }),
    job_tensor_events: () => [],
    model_get: () => D.model_get,
    job_get: () => D.job_get,
  };
  for (const [k, v] of Object.entries(D)) if (!k.startsWith('quant_estimate_')) fromData[k] = fromData[k] || (() => v);
  async function invoke(cmd, args) {
    const fn = fixtures[cmd] || fromData[cmd] || base[cmd];
    await new Promise((r) => setTimeout(r, 10));
    if (!fn) {
      console.warn(`[mock] unhandled command ${cmd}`);
      throw { code: 'mock', message: `Mock has no handler for ${cmd}` };
    }
    return typeof fn === 'function' ? fn(args || {}) : fn;
  }
  async function listen(event, cb) {
    (listeners[event] = listeners[event] || []).push(cb);
    return () => (listeners[event] = listeners[event].filter((x) => x !== cb));
  }
  window.__mockEmit = (event, payload) => (listeners[event] || []).forEach((cb) => cb({ event, payload }));
  window.__TAURI__ = { core: { invoke }, event: { listen } };
})();

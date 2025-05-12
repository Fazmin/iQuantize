# Contributing to iQuantize

Thanks for your interest in improving iQuantize. Bug reports, testing, documentation and code are all welcome.

## Ways to help

- **Test on Windows and Linux.** macOS on Apple Silicon is verified end to end. Windows and Linux build in CI but still need real-machine runs. A report saying "it worked" or "it broke here" is valuable.
- **Report bugs** with enough detail to reproduce them (see [Reporting a bug](#reporting-a-bug)).
- **Improve explanations.** Every option in the app has a plain-English entry in `src/js/kb/`, and the user guide lives in `src/js/help/`. Clearer wording helps everyone.
- **Add features or fix issues.** For anything larger than a small fix, please open an issue first so we can agree on the approach before you spend time on it.

## Development setup

Requirements:

- Rust 1.80 or newer, and the Tauri CLI v2: `cargo install tauri-cli --version ^2`
- Node.js 22 or newer (only for the JavaScript tests and UI screenshots)
- On Linux, the WebKitGTK and related libraries listed in `.github/workflows/ci.yml`

```bash
cd src-tauri
cargo tauri dev      # run the app; the UI is served straight from ../src
```

The app installs its own Python, llama.cpp and packages into its app-data folder, so you don't need them on your system. Two environment variables make development easier:

- `IQUANTIZE_KEY_FILE=1` keeps the secrets key in a file instead of the OS keychain, which avoids keychain prompts after each rebuild.
- `IQUANTIZE_DEV_SCRIPT=script.json` (debug builds only) runs a scripted sequence of IPC calls and page visits at startup. See `src/js/lib/devtools.js`.

The [Layout](README.md#layout) section of the README explains where things live.

## Guidelines

### User interface (`src/`)

- Plain ES modules: no framework, no build step, nothing from a CDN.
- The app runs under a strict Content Security Policy. Don't use inline scripts, `style` attributes or `innerHTML` with untrusted text. Build elements with `h()` from `src/js/lib/dom.js`, which sets styles through the CSSOM.
- Follow the existing visual style. Use the colour and spacing tokens in `src/css/tokens.css`, and keep borders faint: `--divider` for one-sided separators, `--border` for outlines and `--border-2` for controls.
- Icons come from the Lucide sprite in `src/assets/icons.svg`. Add new symbols there.
- Every new option needs a knowledge-base entry in `src/js/kb/`. A test checks that every control has one.
- If you change anything a user sees (labels, steps, behaviour), update the matching article in `src/js/help/`. The guide quotes the real labels.

### Backend (`src-tauri/`)

- All network calls happen in Rust (for example `src/hub.rs`), never in the WebView.
- Secrets are never sent back to the UI; the UI only ever sees a short hint.
- Python drivers in `drivers/` talk to Rust using a JSON-lines protocol. Keep them dependency-light.
- Parsers for tool output are tested against real captured output in `src-tauri/tests/fixtures/`. When a tool's output format changes, add a new fixture rather than editing an old one.

## Before you open a pull request

Run the same checks as CI:

```bash
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cd ..
node --test tests/js/
```

For UI changes, also take screenshots of the affected pages in both themes:

```bash
node tests/ui/harness.mjs /tmp/shots /models /help
```

Then:

1. Keep each pull request focused on one change.
2. Describe what changed and why, and link the issue it addresses.
3. Include before-and-after screenshots for UI changes.
4. Say which platforms you tested on.

## Reporting a bug

Please include:

- your OS, CPU and GPU, and the app version (**Settings → About**);
- the steps to reproduce the problem, and what you expected to happen;
- for a failed job, its log (the **Copy** button on the job page);
- for setup problems, the **System check** section of the Environment page.

Remove any tokens or keys before posting logs. iQuantize never writes secrets to logs, but check anyway.

## Security issues

Please don't report security problems in public issues. Use **Report a vulnerability** on the repository's **Security** tab, so the report stays private until it is fixed.

## License

iQuantize is dual-licensed under the [MIT License](LICENSE-MIT) or the [Apache License, Version 2.0](LICENSE-APACHE), at the user's option. Unless you explicitly state otherwise, any contribution you intentionally submit for inclusion in iQuantize, as defined in the Apache-2.0 license, is dual-licensed the same way, without any additional terms or conditions.

You keep the copyright in your contributions. The project is cited as "iQuantize contributors", which includes you.

Contributors are credited in [CONTRIBUTORS.md](CONTRIBUTORS.md).

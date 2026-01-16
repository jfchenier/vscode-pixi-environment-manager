# Pixi Environment Manager for VS Code

A comprehensive VS Code extension for managing [Pixi](https://pixi.sh) environments. This extension enables seamless integration of Pixi-managed toolchains directly into your VS Code workspace, providing a streamlined and fully integrated development experience.

## Key Features

*   **Automatic Bootstrapping**: Automatically downloads and installs the Pixi binary if it's not present, making onboarding new developers effortless.
*   **Full Window Context**: Injects environment variables (like `PATH`, `CONDA_PREFIX`, and custom variables) into the **entire VS Code window context**. This means terminals, other extensions, and tasks all inherit the activated environment automatically.
*   **Task Support**: Integrate Pixi tasks natively into VS Code. Run tasks via the Status Bar, Command Palette, or standard VS Code "Run Task" menu.
*   **config Watcher**: Automatically detects changes in `pixi.toml` and `pixi.lock` (including external Git operations) and prompts to keep the environment in sync.
*   **Offline Support**: Unique capability to generate and load "offline" environment packs (`.tar.gz` + `.pixi`), enabling reproducible development in air-gapped or restricted networks.

## 🚀 Why this extension?

While there is an official Pixi extension, **Pixi Environment Manager** focuses on a different set of needs:

| Feature | Pixi Environment Manager (This Extension) | Official Pixi Extension |
| :--- | :--- | :--- |
| **Scope** | **Full Setup & Infrastructure**. Automates binary download, offline packing, and deep system integration. | **Task Runner**. Focused on running `pixi run` commands effectively. |
| **Context Integration** | **Window-Wide**. Injects variables into the global collection, so **all** terminals and extensions see the environment by default. | **Terminal-Specific**. Often focuses on specific task terminals. |
| **Language Focus** | **Language Agnostic**. Designed for ANY toolchain managed by Pixi (C++, Rust, Python, Go, Node, System Tools). **Not limited to Python.** | Often associated with Python workflows. |
| **Offline Workflows** | Native commands to pack and unpack offline environments. | Not a primary focus. |

**Use this extension if:**
*   You want a "zero-setup" experience for your team (just open VS Code and it works).
*   You use Pixi to manage general developer tooling (compilers, linters, cloud CLIs), not just Python.
*   You want your `pixi.toml` to drive the *entire* VS Code experience.

## 📦 Usage

### Getting Started
1.  Open a folder containing a `pixi.toml`.
2.  The extension will detect it. If Pixi is missing, it will ask to download it.
3.  The environment will automatically activate. Open a new terminal, and your tools are ready!

### Commands (Command Palette: `Pixi Env: ...`)
*   **Create Environment**: Initialize a new Pixi project or hydrate an existing one.
*   **Activate Environment**: Manually activate a specific environment from `pixi.toml`.
*   **Run Task**: Run a task defined in `pixi.toml` (also available via `$(play) Pixi Tasks` in Status Bar).
*   **Deactivate Environment**: Deactivate the current Pixi environment in the window.
*   **Clear Environment**: Clear the environment cache/state (`.pixi` folder).
*   **Generate Offline Environment**: Create a portable archive of your current environment (requires `pixi-pack`).
*   **Load Offline Environment**: Restore an environment from an offline archive.
*   **Generate Activation Scripts**: Create shell scripts (`activate.sh`, `activate.bat`) for external use.

### Configuration
*   `pixi.defaultEnvironment`: Name of the environment to activate automatically on startup.
*   `pixi.environment`: Fallback environment name to use if no specific environment is selected (default: `default`).
*   `pixi.showDefaultEnvironment`: If `true`, the `default` environment is included in the environment selection list (default: `false`).
*   `pixi.checkUpdates`: Automatically check for Pixi updates on startup (default: `true`).
*   `pixi.useSystemPixi`: If `true`, use the system `pixi` executable instead of the self-contained one (default: `false`).
*   `pixi.disableConfigChangePrompt`: If `true`, suppresses prompts when the Pixi environment (lockfile) is out of sync (default: `false`).
*   `pixi.offlineEnvironmentName`: Name of the directory when unpacking an offline environment (default: `env`).
*   `pixi.autoReload`: Automatically reload the window after activation to ensure all extensions pick up changes.

## 🔧 Building & Contributing

Please refer to [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for instructions on how to build, run, and contribute to this project. We welcome your contributions!

## ⚖️ Legal & Attribution

**Disclaimer**:
This extension is **not** affiliated with, endorsed by, or associated with **prefix.dev** or the **Pixi** project. It is an independent open-source tool designed to help developers use Pixi within VS Code.

**Third-Party Software**:
This extension downloads and uses the **Pixi** executable to manage environments.
Pixi is Copyright (c) prefix.dev GmbH and is licensed under the BSD 3-Clause License.
See `THIRD_PARTY_NOTICES.md` in the extension installation directory for full license text.

## 👏 Credits

*   Powered by [Pixi](https://pixi.sh) package manager by [prefix.dev](https://prefix.dev).
*   Heavily inspired by the [vscode-micromamba](https://github.com/mamba-org/vscode-micromamba) extension.

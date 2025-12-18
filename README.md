# Pixi VS Code

Pixi integration for VS Code. This extension allows you to manage environments using [Pixi](https://pixi.sh/), a high-performance package management tool.

## Features

- **Create Environment**: Initialize a new Pixi environment. If a `pixi.toml` exists, it runs `pixi install`. If not, it runs `pixi init`. The environment is automatically activated upon completion.
- **Activate Environment**: Activate an existing Pixi environment within VS Code. The extension parses `pixi shell-hook` output to inject environment variables directly into the VS Code terminal session, ensuring all tools are available.
- **Deactivate Environment**: Deactivate the current Pixi environment, clearing the injected environment variables and restoring the session to its base state.
- **Offline Environments**: Generate a portable, offline-capable environment package. This creates a tarball and an installer script, allowing deployment on air-gapped systems or machines without a global Pixi installation.
- **Auto-Detection**: The extension automatically detects `pixi.toml` in the workspace root and enables relevant commands.

## Extension Settings

This extension contributes the following settings:

* `pixi.defaultEnvironment`: Specifies the default Pixi environment to automatically activate on startup if no previous environment state is found.
* `pixi.environment`: The fallback environment name to use during activation if no specific environment is selected (default: `default`).
* `pixi.offlineEnvironmentName`: The name given to the directory when unpacking an offline environment (e.g., `.pixi/envs/<name>`). Default is `env`.
* `pixi.autoReload`: If set to `true`, the VS Code window will automatically reload after an environment is activated or deactivated. This ensures that extensions and terminals fully embrace the new environment variables. Default is `false`.

## Commands

The extension provides the following commands via the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`):

* **Pixi: Create Environment** (`pixi.createEnvironment`)
  Initializes a new Pixi project in the current workspace. If a `pixi.toml` already exists, it installs dependencies.

* **Pixi: Activate Environment** (`pixi.activate`)
  Manually activates the Pixi environment. It prompts you to select an environment (if multiple are defined) and injects the variables.

* **Pixi: Deactivate Environment** (`pixi.deactivate`)
  Removes Pixi environment variables from the current VS Code session.

* **Pixi: Clear Environment** (`pixi.clear`)
  Completely resets the environment state by **deleting the `.pixi` folder** and reloading the window. This is useful for performing a clean re-initialization.

* **Pixi: Generate Offline Environment** (`pixi.generateOffline`)
  Creates a standalone offline environment. It uses `pixi-pack` to compress the environment and generates a platform-agnostic installer script (`install.sh`/`install.bat`).

* **Pixi: Load Offline Environment** (`pixi.loadOfflineEnvironment`)
  Prompts for an installer script (from a generated offline environment), unpacks it into the project, and activates it. This allows working in an isolated environment without external dependencies.

## Documentation

For development instructions, please refer to [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

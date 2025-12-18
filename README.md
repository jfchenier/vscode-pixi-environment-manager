# Pixi VS Code

Pixi integration for VS Code. This extension allows you to manage environments using [Pixi](https://pixi.sh/), a high-performance package management tool.

## Features

- **Create Environment**: Initialize a new Pixi environment.
- **Activate Environment**: Activate a Pixi environment within VS Code.
- **Deactivate Environment**: Deactivate the current Pixi environment.
- **Auto-Environment Detection**: Detects and uses environments defined in `pixi.toml`.

## Requirements

- **Pixi**: You must have [Pixi](https://pixi.sh/) installed and available in your system PATH.

## Extension Settings

This extension contributes the following settings:

* `pixi.defaultEnvironment`: Specifies the default Pixi environment to activate automatically on startup.
* `pixi.autoReload`: Automatically reload the VS Code window after activating or deactivating an environment (default: `false`).

## Commands

The extension provides the following commands via the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`):

* `Pixi: Create Environment` (`pixi.createEnvironment`)
* `Pixi: Generate Offline Environment` (`pixi.generateOffline`)
* `Pixi: Load Offline Environment` (`pixi.loadOfflineEnvironment`)
* `Pixi: Activate Environment` (`pixi.activate`)
* `Pixi: Deactivate Environment` (`pixi.deactivate`)
* `Pixi: Clear Environment` (`pixi.clear`)

## Development / Build Instructions

If you want to contribute to the extension or build it from source, follow these steps:

### Prerequisites

* [Node.js](https://nodejs.org/) (version 18 or higher recommended)
* [npm](https://www.npmjs.com/) (usually comes with Node.js)
* [Pixi](https://pixi.sh/) (to test the extension's functionality)

### Cloning the Repository

```bash
git clone https://github.com/jfchenier/jfchenier-SPARK-Pixi-vscode-extension.git
cd jfchenier-SPARK-Pixi-vscode-extension
```

### Building the Project

1.  **Install Dependencies**:

    ```bash
    npm install
    ```

2.  **Compile the Extension**:

    To compile the TypeScript source code to JavaScript:

    ```bash
    npm run compile
    ```

    For continuous compilation during development (watch mode):

    ```bash
    npm run watch
    ```

### Running and Debugging

1.  Open the project in **VS Code**.
2.  Press **F5** to start debugging. This will open a new "Extension Development Host" window with the extension loaded.
3.  In the new window, you can run the Pixi commands to test the functionality.

### Linting

To run the linter:

```bash
npm run lint
```

### Testing

To run the tests:

```bash
npm run test
```

### Packaging

To create a VSIX package for manual installation:

1.  Install `vsce` (VS Code Extension Manager) globally if you haven't already:

    ```bash
    npm install -g @vscode/vsce
    ```

2.  Package the extension:

    ```bash
    vsce package
    ```

    This will generate a `.vsix` file in the project directory, which can be installed in VS Code via "Install from VSIX...".

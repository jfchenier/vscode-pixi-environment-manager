# Pixi Extension Development Guide

This guide describes how to build, run, and test the Pixi VS Code extension from source.

## Prerequisites

* [Node.js](https://nodejs.org/) (version 18 or higher recommended)
* [npm](https://www.npmjs.com/) (usually comes with Node.js)
* [Pixi](https://pixi.sh/) (Optional: Useful for manual verification, but the extension can download its own copy)

## Architecture

For a deep dive into how the code works, please see [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/jfchenier/jfchenier-SPARK-Pixi-vscode-extension.git
    cd jfchenier-SPARK-Pixi-vscode-extension
    ```

2.  **Install Dependencies**:
    ```bash
    npm install
    ```

## Building

To compile the TypeScript source code to JavaScript:

```bash
npm run compile
```

For continuous compilation during development (watch mode):

```bash
npm run watch
```

## Running and Debugging

1.  Open the project in **VS Code**.
2.  Press **F5** to start debugging. This will open a new "Extension Development Host" window with the extension loaded.
3.  In the new window, you can run the Pixi commands to verify functionality.

## Linting

To run the linter:

```bash
npm run lint
```

## Testing

To run the integration tests:

```bash
npm run test
```

## Packaging

To create a VSIX package for manual installation or publishing:

1.  Install `vsce` globally if needed:
    ```bash
    npm install -g @vscode/vsce
    ```

2.  Package the extension:
    ```bash
    vsce package
    ```

This will generate a `.vsix` file in the project directory.

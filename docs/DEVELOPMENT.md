# Development Guide

This document provides instructions on how to set up the environment, build the extension, and run it locally.

## Prerequisites
- **Node.js**: Version 20 or higher.
- **npm**: Included with Node.js.

## Setup

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/jfchenier/vscode-pixi-environment-manager.git
    cd vscode-pixi-environment-manager
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

## Building

To compile the source code:
```bash
npm run compile
```

To watch for changes (useful during development):
```bash
npm run watch
```

## Running the Extension

1.  Open the project directory in VS Code.
2.  Press **F5** (or go to `Run` -> `Start Debugging`).
3.  This will launch a new VS Code window (Extension Development Host) with the extension loaded.

## Testing

Run the full test suite:
```bash
npm run test
```

Run linter:
```bash
npm run lint
```

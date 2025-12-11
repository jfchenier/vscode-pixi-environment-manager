import * as vscode from 'vscode';
import { PixiManager } from './pixi';
import { EnvironmentManager } from './environment';

export function activate(context: vscode.ExtensionContext) {
    console.log('Pixi VSCode Active');

    const outputChannel = vscode.window.createOutputChannel("Pixi");
    const pixiManager = new PixiManager(outputChannel);
    const envManager = new EnvironmentManager(pixiManager, context, outputChannel);

    let createEnvDisposable = vscode.commands.registerCommand('pixi.createEnvironment', () => {
        envManager.createEnvironment();
    });

    let activateDisposable = vscode.commands.registerCommand('pixi.activate', async () => {
        await envManager.activate(); // We need to fix activate signature to accept context if we use EnvVarCollection
        // For now, we are just mocking the reload flow. 
        // Real implementation of injecting env vars comes next.

        // Context: To fully implement activation (affecting terminals), we need context.environmentVariableCollection.
        // I will update EnvironmentManager to take context.
    });

    let deactivateDisposable = vscode.commands.registerCommand('pixi.deactivate', async () => {
        await envManager.deactivate();
    });

    context.subscriptions.push(createEnvDisposable);
    context.subscriptions.push(activateDisposable);
    context.subscriptions.push(deactivateDisposable);

    // Auto-activate saved environment
    envManager.autoActivate();
}


export function deactivate() { }

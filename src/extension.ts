import * as vscode from 'vscode';
import { PixiManager } from './pixi';
import { EnvironmentManager } from './environment';

export async function activate(context: vscode.ExtensionContext) {

    const outputChannel = vscode.window.createOutputChannel("Pixi");
    const pixiManager = new PixiManager(outputChannel);
    const envManager = new EnvironmentManager(pixiManager, context, outputChannel);

    let createEnvDisposable = vscode.commands.registerCommand('pixi.createEnvironment', () => {
        envManager.createEnvironment();
    });

    let loadOfflineEnvDisposable = vscode.commands.registerCommand('pixi.loadOfflineEnvironment', async () => {
        await envManager.loadOfflineEnvironment();
    });

    let activateDisposable = vscode.commands.registerCommand('pixi.activate', async () => {
        await envManager.activate(); 
    });

    let deactivateDisposable = vscode.commands.registerCommand('pixi.deactivate', async () => {
        await envManager.deactivate();
    });

    let clearDisposable = vscode.commands.registerCommand('pixi.clear', async () => {
        await envManager.clearEnvironment();
    });

    let generateOfflineDisposable = vscode.commands.registerCommand('pixi.generateOffline', async () => {
        await envManager.generateOfflineEnvironment();
    });



    context.subscriptions.push(createEnvDisposable);
    context.subscriptions.push(loadOfflineEnvDisposable);
    context.subscriptions.push(activateDisposable);
    context.subscriptions.push(deactivateDisposable);
    context.subscriptions.push(clearDisposable);
    context.subscriptions.push(generateOfflineDisposable);

    // Auto-activate saved environment
    await envManager.autoActivate();
}


export function deactivate() { }

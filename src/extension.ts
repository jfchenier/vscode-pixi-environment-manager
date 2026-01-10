import * as vscode from 'vscode';
import { PixiManager } from './pixi';
import { EnvironmentManager } from './environment';

export async function activate(context: vscode.ExtensionContext) {

    const outputChannel = vscode.window.createOutputChannel("Pixi");
    const pixiManager = new PixiManager(outputChannel);
    const envManager = new EnvironmentManager(pixiManager, context, outputChannel);

    const createEnvDisposable = vscode.commands.registerCommand('pixi.createEnvironment', () => {
        envManager.createEnvironment();
    });

    const loadOfflineEnvDisposable = vscode.commands.registerCommand('pixi.loadOfflineEnvironment', async () => {
        await envManager.loadOfflineEnvironment();
    });

    const activateDisposable = vscode.commands.registerCommand('pixi.activate', async () => {
        await envManager.activate();
    });

    const deactivateDisposable = vscode.commands.registerCommand('pixi.deactivate', async () => {
        await envManager.deactivate();
    });

    const clearDisposable = vscode.commands.registerCommand('pixi.clear', async () => {
        await envManager.clearEnvironment();
    });

    const generateOfflineDisposable = vscode.commands.registerCommand('pixi.generateOffline', async () => {
        await envManager.generateOfflineEnvironment();
    });

    const generateScriptsDisposable = vscode.commands.registerCommand('pixi.generateScripts', async () => {
        await envManager.generateScripts();
    });



    context.subscriptions.push(createEnvDisposable);
    context.subscriptions.push(loadOfflineEnvDisposable);
    context.subscriptions.push(activateDisposable);
    context.subscriptions.push(deactivateDisposable);
    context.subscriptions.push(clearDisposable);
    context.subscriptions.push(generateOfflineDisposable);
    context.subscriptions.push(generateScriptsDisposable);

    // Check for global pixi
    pixiManager.checkAndPromptGlobalPixi(context);

    // Auto-activate saved environment
    await envManager.autoActivate();


    // Listen for configuration changes to trigger auto-activation if defaultEnvironment changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('pixi.defaultEnvironment')) {
            envManager.autoActivate();
        }
    }));

    // Check for updates (non-blocking)
    pixiManager.checkUpdate(context).catch(e => {
        console.error("Failed to check for updates:", e);
    });
}


export function deactivate() { }

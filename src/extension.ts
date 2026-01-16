import * as vscode from 'vscode';
import { PixiManager } from './pixi';
import { EnvironmentManager } from './environment';
import { PixiTaskProvider } from './tasks';

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

    // Check for system pixi
    pixiManager.checkAndPromptSystemPixi(context);

    // Auto-activate saved environment
    outputChannel.appendLine("Pixi: Attempting auto-activation on startup...");
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

    // Watch for pixi.toml/lock changes
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    let watcher: vscode.FileSystemWatcher | undefined;

    if (workspaceFolder) {
        // Use RelativePattern for better reliability across different OS/Git operations
        const pattern = new vscode.RelativePattern(workspaceFolder, "**/{pixi.toml,pixi.lock}");
        watcher = vscode.workspace.createFileSystemWatcher(pattern);
        outputChannel.appendLine("Pixi: Config Watcher initialized with RelativePattern.");
    } else {
        // Fallback for empty workspace? Pixi doesn't really work without workspace folder generally settings-wise
        watcher = vscode.workspace.createFileSystemWatcher('**/pixi.{toml,lock}');
        outputChannel.appendLine("Pixi: Config Watcher initialized with global pattern.");
    }

    let debounceTimer: NodeJS.Timeout;

    const handleConfigChange = (uri: vscode.Uri) => {
        const fsPath = uri.fsPath;
        // Double check extension just in case
        if (!fsPath.endsWith('pixi.toml') && !fsPath.endsWith('pixi.lock')) {
            return;
        }

        outputChannel.appendLine(`Pixi: Config change detected on ${fsPath}`);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            // Unified check logic also respects 'disableConfigChangePrompt'
            // and prompts if out of sync.
            // We pass the filename to detect lockfile-specific changes (git stash/pull)
            // even if status check passes.
            await envManager.checkAndPromptForUpdate(false, fsPath);
        }, 1000);
    };

    if (watcher) {
        context.subscriptions.push(watcher.onDidChange(handleConfigChange));
        context.subscriptions.push(watcher.onDidCreate(handleConfigChange));
        context.subscriptions.push(watcher.onDidDelete(handleConfigChange));
        context.subscriptions.push(watcher);
    }

    // Also listen to editor saves (more reliable for in-editor changes)
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
        const fsPath = doc.uri.fsPath;
        if (fsPath.endsWith('pixi.toml') || fsPath.endsWith('pixi.lock')) {
            outputChannel.appendLine(`Pixi: Document saved in editor: ${fsPath}`);
            handleConfigChange(doc.uri);
        }
    }));

    // Task Support
    if (workspaceFolder) {
        const taskProvider = new PixiTaskProvider(workspaceFolder.uri.fsPath, pixiManager);
        context.subscriptions.push(vscode.tasks.registerTaskProvider(PixiTaskProvider.PixiType, taskProvider));

        // Command: Run Task
        context.subscriptions.push(vscode.commands.registerCommand('pixi.runTask', async () => {
            const tasks = await taskProvider.provideTasks();
            if (!tasks || tasks.length === 0) {
                vscode.window.showInformationMessage('No tasks found in pixi.toml.');
                return;
            }

            const items = tasks.map(task => ({
                label: task.name,
                description: task.detail,
                task: task
            }));

            const selection = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a Pixi task to run'
            });

            if (selection) {
                vscode.tasks.executeTask(selection.task);
            }
        }));

        // Status Bar Item
        const statusBarTask = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        statusBarTask.text = "$(play) Pixi Tasks";
        statusBarTask.command = "pixi.runTask";
        statusBarTask.tooltip = "Run a Pixi task";
        statusBarTask.show();
        context.subscriptions.push(statusBarTask);

        // Invalidate tasks on config change
        if (watcher) {
            context.subscriptions.push(watcher.onDidChange(() => taskProvider.invalidate()));
            context.subscriptions.push(watcher.onDidCreate(() => taskProvider.invalidate()));
            context.subscriptions.push(watcher.onDidDelete(() => taskProvider.invalidate()));
        }
    }
}


export function deactivate() { }

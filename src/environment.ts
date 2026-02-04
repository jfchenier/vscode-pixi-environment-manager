import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PixiManager } from './pixi';
import { ScriptGenerator } from './features/scripts';
import { OfflineManager } from './features/offline';
import { IPixiEnvironmentManager } from './interfaces';

export class EnvironmentManager implements IPixiEnvironmentManager {
    private _pixiManager: PixiManager;
    private _context: vscode.ExtensionContext;
    private _exec: (command: string, options?: any) => Promise<{ stdout: string, stderr: string }>;
    private _outputChannel: vscode.OutputChannel | undefined;
    private _terminalListener: vscode.Disposable | undefined;
    private _statusBarItem: vscode.StatusBarItem;
    private static readonly envStateKey = 'pixiSelectedEnvironment';
    private static readonly cachedEnvKey = 'pixi.cachedEnv';
    public isUpdating = false;
    private isChecking = false;

    private scriptGenerator: ScriptGenerator;
    private offlineManager: OfflineManager;

    constructor(pixiManager: PixiManager, context: vscode.ExtensionContext, outputChannel?: vscode.OutputChannel, exec?: (command: string, options?: any) => Promise<{ stdout: string, stderr: string }>) {
        this._pixiManager = pixiManager;
        this._context = context;
        this._outputChannel = outputChannel;
        if (exec) {
            this._exec = exec;
        } else {
            const cp = require('child_process');
            this._exec = require('util').promisify(cp.exec);
        }

        // Initialize features
        this.scriptGenerator = new ScriptGenerator(outputChannel);
        this.offlineManager = new OfflineManager(this);

        // Initialize Status Bar Item
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this._statusBarItem.command = 'pixi.activate'; // Click to switch/activate
        this._context.subscriptions.push(this._statusBarItem);

        // Initial Context Check
        this.updatePixiContext();

        // Show initial status
        const savedEnv = this._context.workspaceState.get<string>(EnvironmentManager.envStateKey);
        this.updateStatusBar(savedEnv);
    }

    // --- Interface Implementation ---

    public getPixiManager(): PixiManager {
        return this._pixiManager;
    }

    public getContext(): vscode.ExtensionContext {
        return this._context;
    }

    public log(message: string) {
        if (this._outputChannel) {
            this._outputChannel.appendLine(message);
        }
    }

    public async exec(command: string, options?: any): Promise<{ stdout: string, stderr: string }> {
        return this._exec(command, options);
    }

    // --------------------------------

    private updatePixiContext() {
        const workspaceUri = this.getWorkspaceFolderURI();
        if (workspaceUri) {
            const pixiDir = path.join(workspaceUri.fsPath, '.pixi');
            const tomlPath = path.join(workspaceUri.fsPath, 'pixi.toml');

            const hasPixiDir = fs.existsSync(pixiDir);
            const hasToml = fs.existsSync(tomlPath);

            vscode.commands.executeCommand('setContext', 'pixi.hasPixiDirectory', hasPixiDir);
            vscode.commands.executeCommand('setContext', 'pixi.hasProjectManifest', hasToml);

            this._pixiManager.isPixiInstalled().then(isInstalled => {
                vscode.commands.executeCommand('setContext', 'pixi.isPixiInstalled', isInstalled);
            });
        }
    }

    public updateStatusBar(envName?: string) {
        if (envName) {
            this._statusBarItem.text = `$(terminal) ${envName}`;
            this._statusBarItem.tooltip = `Pixi Environment: ${envName}`;
        } else {
            this._statusBarItem.text = `$(terminal) Pixi`;
            this._statusBarItem.tooltip = `Click to Activate or Create Pixi Environment`;
        }
        this._statusBarItem.show();
    }


    public getWorkspaceFolderURI(): vscode.Uri | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri;
    }

    public async createEnvironment() {
        if (!this.getWorkspaceFolderURI()) {
            vscode.window.showErrorMessage('No workspace open.');
            return;
        }

        try {
            const installed = await this._pixiManager.isPixiInstalled();
            if (!installed) {
                // Auto-download without prompt
                await this._pixiManager.installPixi();
            }

            // Check if pixi.toml exists
            const workspacePath = this.getWorkspaceFolderURI()!.fsPath;
            const tomlPath = path.join(workspacePath, 'pixi.toml');

            if (fs.existsSync(tomlPath)) {
                vscode.window.showInformationMessage("pixi.toml found.");
            } else {
                await this._pixiManager.initProject();
                vscode.window.showInformationMessage("Pixi project initialized.");
            }

            // Auto-activate after creation/install
            await this.activate();

            this.updatePixiContext();

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create environment: ${error.message}`);
        }
    }


    public async getEnvironments(): Promise<string[]> {
        const pixiPath = this._pixiManager.getPixiPath();
        const workspaceUri = this.getWorkspaceFolderURI();
        if (!pixiPath || !workspaceUri) { return []; }

        try {
            const cmd = `"${pixiPath}" info --json`;
            const { stdout } = await this._exec(cmd, {
                cwd: workspaceUri.fsPath
            });
            const info = JSON.parse(stdout); // Need a type?
            if (info.environments_info && Array.isArray(info.environments_info)) {

                const config = vscode.workspace.getConfiguration('pixi');
                const showDefault = config.get<boolean>('showDefaultEnvironment', false);
                const ignoredPatterns = config.get<string[]>('ignoredEnvironments', []);

                return info.environments_info
                    .map((e: any) => e.name)
                    .filter((n: string, _: number, arr: string[]) => {
                        // Always show default if it's the only environment
                        if (n === 'default' && arr.length === 1 && arr[0] === 'default') {
                            return true;
                        }

                        if (!showDefault && n === 'default') { return false; }
                        // Check ignored patterns
                        for (const pattern of ignoredPatterns) {
                            try {
                                if (new RegExp(pattern).test(n)) { return false; }
                            } catch {
                                console.warn(`Invalid regex in pixi.ignoredEnvironments: ${pattern}`);
                            }
                        }
                        return true;
                    });
            }
            return [];
        } catch (e) {
            console.error("Failed to get environments info", e);
            return [];
        }
    }

    public async autoActivate(overrideSavedState: boolean = false) {
        let savedEnv = overrideSavedState ? undefined : this._context.workspaceState.get<string>(EnvironmentManager.envStateKey);
        this.log(`AutoActivate: Saved state is '${savedEnv}' (override: ${overrideSavedState})`);

        if (savedEnv) {
            // Validate that the saved environment actually exists on disk.
            // If the .pixi directory was deleted, we must clear this state to trigger the "fresh start" logic below (which ensures pixi is installed).
            const workspaceUri = this.getWorkspaceFolderURI();
            if (workspaceUri) {
                // Assumption: env directory matches env name.
                const envDir = path.join(workspaceUri.fsPath, '.pixi', 'envs', savedEnv);
                if (!fs.existsSync(envDir)) {
                    this.log(`AutoActivate: Saved environment '${savedEnv}' not found at '${envDir}'. Clearing state.`);
                    savedEnv = undefined;
                    // Clear persistent state immediately so subsequent logic behaves as if fresh.
                    await this._context.workspaceState.update(EnvironmentManager.envStateKey, undefined);
                    vscode.commands.executeCommand('setContext', 'pixi.isEnvironmentActive', false);
                }
            }
        }

        // If no saved environment from a previous session (or overridden), check user configuration
        if (!savedEnv) {
            const config = vscode.workspace.getConfiguration('pixi');
            const defaultEnv = config.get<string>('defaultEnvironment');
            this.log(`AutoActivate: Configured default is '${defaultEnv}'`);

            if (defaultEnv) {
                // Verify the configured environment actually exists
                const envs = await this.getEnvironments();
                this.log(`AutoActivate: Available environments: ${envs.join(', ')}`);

                if (envs.includes(defaultEnv)) {
                    savedEnv = defaultEnv;
                    this.log(`AutoActivate: Default environment '${defaultEnv}' found and selected.`);
                } else if (envs.length === 0) {
                    // If no environments were found, but a default is configured, trust the configuration.
                    savedEnv = defaultEnv;
                    this.log(`AutoActivate: No environments discovered. Trusting configured default '${defaultEnv}' and proceeding.`);

                    // Ensure pixi binary exists before attempting install/activate in this fresh scenario
                    try {
                        await this._pixiManager.ensurePixi();
                    } catch (e) {
                        this.log(`AutoActivate: Failed to ensure pixi binary: ${e}`);
                    }

                    // Force install because state is fresh/empty.
                    // Also pass silent=false so the user gets the Reload Window prompt after this heavy operation.
                    await this.activate(false, savedEnv);
                    return;
                } else {
                    this._outputChannel?.appendLine(`Configured default environment '${defaultEnv}' not found. options: ${envs.join(', ')}`);
                }
            }
        }

        // Just in case no environment is saved/found, ensure context is false
        if (!savedEnv) {
            vscode.commands.executeCommand('setContext', 'pixi.isEnvironmentActive', false);
        }

        if (savedEnv) {
            this._outputChannel?.appendLine(`Auto-activating saved/default environment: ${savedEnv}`);
            if (savedEnv !== this._context.workspaceState.get<string>(EnvironmentManager.envStateKey)) {
                await this._context.workspaceState.update(EnvironmentManager.envStateKey, savedEnv);
            }

            // Call the main activate method which handles Offline vs Online and Caching
            await this.activate(true);
        }
    }

    public getCurrentEnvName(): string | undefined {
        const savedEnv = this._context.workspaceState.get<string>(EnvironmentManager.envStateKey);
        const config = vscode.workspace.getConfiguration('pixi');
        const defaultEnv = config.get<string>('environment', 'default');
        return savedEnv || defaultEnv;
    }

    public async activate(silent: boolean = false, forceEnv?: string): Promise<void> {
        // Check for Offline Mode
        const config = vscode.workspace.getConfiguration('pixi');
        const offlineName = config.get<string>('offlineEnvironmentName', 'env');
        const workspaceRoot = this.getWorkspaceFolderURI()?.fsPath;

        let currentEnv: string | undefined;

        try {
            const savedEnv = this._context.workspaceState.get<string>(EnvironmentManager.envStateKey);
            const defaultEnv = config.get<string>('environment', 'default');
            currentEnv = savedEnv || defaultEnv;

            // Clear any existing environment variables to ensure a clean slate
            // This prevents persistent "pollution" (e.g. TERM/TERMINFO) from previous incomplete/bad activations.
            this._context.environmentVariableCollection.clear();

            await this.checkMicromambaConflict();

            // --- CACHE VARS ---
            if (currentEnv === offlineName) {
                const cached = this._context.workspaceState.get<any>(EnvironmentManager.cachedEnvKey);
                if (cached && cached.envName === offlineName && cached.envVars) {
                    this.log(`Found cached environment for '${offlineName}'. Applying instantaneously.`);
                    for (const key in cached.envVars) {
                        if (key === 'TERM' || key === 'TERMINFO' || key === 'TERMINFO_DIRS') { continue; } // Skip terminal vars
                        const value = cached.envVars[key];
                        process.env[key] = value;
                        this._context.environmentVariableCollection.replace(key, value);
                    }
                }
            }
            // ------------------

            // Only auto-activate offline directly if running silently (startup).
            if (silent && currentEnv === offlineName && workspaceRoot) {
                const envDir = path.join(workspaceRoot, '.pixi', 'envs', offlineName);
                if (fs.existsSync(envDir)) {
                    this.log(`Offline env found. Activating...`);
                    const handled = await this.offlineManager.activateOfflineEnvironment(envDir, offlineName, silent);
                    if (handled) {
                        return;
                    }
                }
                // If script missing (handled == false) and silent is false, warn the user.
                if (!silent) {
                    vscode.window.showWarningMessage(`Offline environment '${offlineName}' not found using standard activation.`);
                }
            }
        } catch (e) {
            console.error("Error in offline logic checks:", e);
        }

        const offlineEnvDir = workspaceRoot ? path.join(workspaceRoot, '.pixi', 'envs', offlineName) : '';
        const offlineAvailable = offlineEnvDir ? fs.existsSync(offlineEnvDir) : false;

        const installed = await this._pixiManager.isPixiInstalled();
        if (!installed) {
            if (offlineAvailable) {
                // Pixi missing, but offline env exists. Offer it.
                if (!silent) {
                    const pick = await vscode.window.showQuickPick([offlineName], {
                        placeHolder: 'Pixi not found, but offline environment detected.',
                        title: 'Select Environment'
                    });
                    if (pick === offlineName) {
                        await this._context.workspaceState.update(EnvironmentManager.envStateKey, offlineName);
                        // Trigger logic directly
                        if (workspaceRoot) {
                            const envDir = path.join(workspaceRoot, '.pixi', 'envs', offlineName);
                            const handled = await this.offlineManager.activateOfflineEnvironment(envDir, offlineName, silent);
                            if (handled) { return; }
                        }
                        // Fallback if not handled (shouldn't happen if user picked it from "offline detected", but safe)
                        if (!silent) {
                            vscode.window.showErrorMessage(`Offline environment script not found for '${offlineName}'.`);
                        }
                        return;
                    }
                } else {
                    // Auto-activate offline if silent request?
                    // Probably yes, if it's the only hope.
                    await this._context.workspaceState.update(EnvironmentManager.envStateKey, offlineName);
                    if (workspaceRoot) {
                        const envDir = path.join(workspaceRoot, '.pixi', 'envs', offlineName);
                        const handled = await this.offlineManager.activateOfflineEnvironment(envDir, offlineName, silent);
                        if (handled) { return; }
                    }
                    // If not handled, fall through to return
                }
            }

            this.log(`Pixi executable not found.`);
            // Only error if offline failed AND missed pixi
            if (!silent) {
                const selection = await vscode.window.showInformationMessage(
                    "Pixi not found. Would you like to create a new environment?",
                    "Create Environment"
                );
                if (selection === "Create Environment") {
                    await this.createEnvironment();
                }
            }
            return;
        }

        const envs = await this.getEnvironments();
        // Add offline environment to candidates if available and not already listed
        if (offlineAvailable && !envs.includes(offlineName)) {
            envs.push(offlineName);
        }

        let selectedEnv = forceEnv || '';

        if (!selectedEnv) {
            if (!silent && envs.length > 0) {
                if (envs.length === 1) {
                    selectedEnv = envs[0];
                } else {
                    const pick = await vscode.window.showQuickPick(envs, {
                        placeHolder: 'Select Pixi Environment to Activate'
                    });
                    if (!pick) { return; }
                    selectedEnv = pick;
                }
            } else {
                // Silent or Auto-selection Logic
                // 1. Try to use currently configured/saved environment
                if (currentEnv && (envs.includes(currentEnv) || currentEnv === 'default')) {
                    selectedEnv = currentEnv;
                }
            }
        }

        if (selectedEnv) {
            await this._context.workspaceState.update(EnvironmentManager.envStateKey, selectedEnv);

            // If offline selected, trigger offline logic explicitly
            if (selectedEnv === offlineName) {
                if (workspaceRoot) {
                    const envDir = path.join(workspaceRoot, '.pixi', 'envs', offlineName);
                    const handled = await this.offlineManager.activateOfflineEnvironment(envDir, offlineName, silent);
                    if (handled) { return; }
                }
                // If not handled (return false), it means script missing.
                // Fall through to doActivate to try standard activation for this name.
            }
        }

        await this.doActivate(selectedEnv, silent);
    }

    private async doActivate(envName: string, silent: boolean, forceInstall: boolean = false) {

        // Ensure envName isn't referring to an offline environment that failed script activation above.
        // If it is regular, Pixi handles it.

        const workspaceUri = this.getWorkspaceFolderURI();
        if (!workspaceUri) { return; }

        // If the environment directory does not exist, force an install.
        // This handles cases where .pixi is deleted but state thinks it's active.
        const directoryName = envName || 'default';
        const envPath = path.join(workspaceUri.fsPath, '.pixi', 'envs', directoryName);
        if (!fs.existsSync(envPath)) {
            forceInstall = true;
        }

        const pixiPath = this._pixiManager.getPixiPath();

        if (!silent) {
            const config = vscode.workspace.getConfiguration('pixi');
            const autoReload = config.get<boolean>('autoReload');
            if (autoReload) {
                const action = forceInstall ? "Creating" : "Activating";
                vscode.window.showInformationMessage(`Pixi: ${action} environment... (Auto-reloading)`);
            }
        }

        // Step 1: Run 'pixi install' visibly if not silent OR forced
        if (!silent || forceInstall) {
            try {
                await this.runInstallInTerminal(pixiPath!, workspaceUri, envName);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Pixi install failed: ${e.message}`);
                return; // Stop activation if install fails
            }
        }

        try {
            await this.checkMicromambaConflict();

            // Use --json to get the resolved environment variables directly
            const cmd = `"${pixiPath}" shell-hook --json${envName ? ` -e "${envName}"` : ''}`;

            this.log(`Activating environment: ${envName || 'default'} with command: ${cmd}`);

            // Show progress
            const location = silent ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification;
            const title = "Activating Pixi Environment (syncing)...";

            const { stdout, stderr } = await vscode.window.withProgress({
                location,
                title,
                cancellable: false
            }, async () => {
                this.isUpdating = true;
                try {
                    return await this._exec(cmd, {
                        cwd: workspaceUri.fsPath
                    });
                } finally {
                    // Small delay to let watcher debounce settle if it triggered
                    setTimeout(() => { this.isUpdating = false; }, 2000);
                }
            });

            // Log stderr
            if (stderr && stderr.trim().length > 0) {
                this.log(`Activation Script Output:\n${stderr}`);
            }

            this.log(`Command output (json):\n${stdout}`);

            let envVars: { [key: string]: string } = {};
            try {
                const parsed = JSON.parse(stdout);
                if (parsed.environment_variables) {
                    envVars = parsed.environment_variables;
                }
            } catch (e: any) {
                this.log(`Failed to parse shell-hook JSON: ${e}`);
                throw new Error(`Failed to parse Pixi output: ${e.message}`);
            }

            // Apply to VSCode environment
            const envUpdates = new Map<string, { value: string, op: 'replace' | 'prepend' | 'append' }>();

            for (const key in envVars) {
                const value = envVars[key];
                envUpdates.set(key, { value, op: 'replace' });
            }

            for (const [key, update] of envUpdates) {
                let { value } = update;
                if (key === 'PATH' && pixiPath) {
                    const pixiBinDir = path.dirname(pixiPath);
                    if (!value.includes(pixiBinDir)) {
                        value = `${pixiBinDir}${path.delimiter}${value}`;
                    }
                }

                this._context.environmentVariableCollection.replace(key, value);
                process.env[key] = value;
            }

            if (!silent) {
                const config = vscode.workspace.getConfiguration('pixi');
                const autoReload = config.get<boolean>('autoReload');

                vscode.window.showInformationMessage(`Pixi environment '${envName || 'default'}' activated.`);

                if (autoReload) {
                    vscode.window.showInformationMessage("Reloading window to apply changes...");
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                } else {
                    const selection = await vscode.window.showInformationMessage(
                        "Environment activated. Reload window to ensure all extensions pick up changes?",
                        "Reload", "Later"
                    );
                    if (selection === "Reload") {
                        vscode.commands.executeCommand("workbench.action.reloadWindow");
                    }
                }
                // Inject activation output into terminal startup (Bash/Zsh)
                if (stderr && stderr.trim().length > 0 && process.platform !== 'win32') {
                    const msg = stderr.trim().replace(/'/g, "'\\''"); // Escape single quotes
                    this._context.environmentVariableCollection.replace('PIXI_ACTIVATION_MSG', msg);
                    this._context.environmentVariableCollection.prepend('PROMPT_COMMAND', `if [ -n "$PIXI_ACTIVATION_MSG" ]; then echo "$PIXI_ACTIVATION_MSG"; unset PIXI_ACTIVATION_MSG; fi; `);
                }
            } else {
                console.log('Pixi environment activated silently.');
            }
            vscode.commands.executeCommand('setContext', 'pixi.isEnvironmentActive', true);

        } catch (e: any) {
            if (!silent) {
                vscode.window.showErrorMessage(`Failed to activate environment: ${e.message}`);
            } else {
                console.error(`Failed to auto-activate environment: ${e.message}`);
            }
        }
    }

    private async checkMicromambaConflict() {
        try {
            const commands = await vscode.commands.getCommands(true);
            const candidates = [
                'corker.micromamba.deactivate.environment', // User confirmed this works
                'micromamba.deactivate',
                'micromamba.deactivateEnvironment'
            ];

            const commandToRun = candidates.find(c => commands.includes(c));

            if (commandToRun) {
                const condaPrefix = process.env.CONDA_PREFIX
                const envPath = process.env.PATH || '';

                // Check 1: CONDA_PREFIX points to a non-base, non-Pixi environment
                const isPrefixActive = condaPrefix
                    && process.env.CONDA_DEFAULT_ENV !== 'base'
                    && !condaPrefix.includes('.pixi/envs');

                // Check 2: PATH contains a Micromamba environment (fallback if CONDA_PREFIX is masked)
                // Look for 'micromamba/envs/' which strongly suggests a named environment.
                const isPathActive = envPath.includes('micromamba/envs/') || envPath.includes('micromamba\\envs\\');

                const isMambaActive = isPrefixActive || isPathActive;

                if (isMambaActive) {
                    this.log(`Conflicting Micromamba command detected: ${commandToRun}`);
                    this.log(`Deactivating Micromamba environment...`);
                    await vscode.commands.executeCommand(commandToRun);

                    // Vital: Wait for Micromamba deactivation to propagate to env collection
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        } catch (e) {
            this.log(`Error checking/deactivating Micromamba: ${e}`);
        }

        // Clear environment variables when explicitly deactivating.
        this._context.environmentVariableCollection.clear();
    }

    public async runInstallInTerminal(pixiPath: string, workspaceUri: vscode.Uri, envName?: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const taskDefinition = {
                type: 'pixi',
                task: 'install'
            };

            const installCmd = `"${pixiPath}" install${envName ? ` -e "${envName}"` : ''}`;
            const fullCommand = process.platform === 'win32'
                ? `& \\"${pixiPath}\\" install${envName ? ` -e \\"${envName}\\"` : ''}`
                : installCmd;

            const shellExecutionOptions = this.getSafeShellExecutionOptions(workspaceUri.fsPath);

            const task = new vscode.Task(
                taskDefinition,
                vscode.workspace.getWorkspaceFolder(workspaceUri) || vscode.TaskScope.Workspace,
                `Install${envName ? ` (${envName})` : ''}`,
                'pixi',
                new vscode.ShellExecution(fullCommand, shellExecutionOptions),
                []
            );

            task.presentationOptions = {
                reveal: vscode.TaskRevealKind.Always,
                panel: vscode.TaskPanelKind.Dedicated,
                clear: true,
                close: false // Keep terminal open
            };

            // Execute the task
            this.isUpdating = true; // Prevent watcher loop
            vscode.tasks.executeTask(task).then(execution => {
                const disposable = vscode.tasks.onDidEndTaskProcess(e => {
                    if (e.execution === execution) {
                        disposable.dispose();
                        this.isUpdating = false; // Reset flag
                        if (e.exitCode === 0) {
                            resolve();
                        } else {
                            reject(new Error(`Pixi install failed with exit code ${e.exitCode}`));
                        }
                    }
                });
            }, error => {
                this.isUpdating = false; // Reset flag on error
                reject(new Error(`Failed to start task: ${error}`));
            });
        });
    }

    public async deactivate(silent: boolean = false) {
        // Clear saved state
        await this._context.workspaceState.update(EnvironmentManager.envStateKey, undefined);
        await this._context.workspaceState.update(EnvironmentManager.cachedEnvKey, undefined);

        const config = vscode.workspace.getConfiguration('pixi');
        const offlineName = config.get<string>('offlineEnvironmentName', 'env');
        const currentConfigEnv = config.get<string>('environment');

        if (currentConfigEnv === offlineName) {
            await config.update('environment', undefined, vscode.ConfigurationTarget.Workspace);
        }

        this._context.environmentVariableCollection.clear();

        if (!silent) {
            const autoReload = config.get<boolean>('autoReload');

            if (autoReload) {
                vscode.window.showInformationMessage("Environment deactivated. Reloading window...");
                vscode.commands.executeCommand("workbench.action.reloadWindow");
            } else {
                const selection = await vscode.window.showInformationMessage(
                    "Environment deactivated. Reload window to apply changes?",
                    "Reload", "Later"
                );
                if (selection === "Reload") {
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
            }
        }
        if (this._terminalListener) {
            this._terminalListener.dispose();
            this._terminalListener = undefined;
        }
        vscode.commands.executeCommand('setContext', 'pixi.isEnvironmentActive', false);
        this.updateStatusBar(undefined);
    }

    public async generateOfflineEnvironment() {
        return this.offlineManager.generateOfflineEnvironment();
    }

    public async loadOfflineEnvironment() {
        return this.offlineManager.loadOfflineEnvironment();
    }

    public async clearEnvironment() {
        return this.offlineManager.clearEnvironment();
    }

    public async generateScripts() {
        if (!this.getWorkspaceFolderURI()) {
            vscode.window.showErrorMessage('No workspace open.');
            return;
        }
        return this.scriptGenerator.generateScripts(this.getWorkspaceFolderURI()!);
    }

    public async checkAndPromptForUpdate(silent: boolean = false, changedFile?: string): Promise<boolean> {
        if (this.isChecking) { return false; } // Prevent re-entry

        const config = vscode.workspace.getConfiguration('pixi');
        if (config.get<boolean>('disableConfigChangePrompt')) {
            return false;
        }

        const workspaceUri = this.getWorkspaceFolderURI();
        if (!workspaceUri) { return false; }

        // Check if an environment is currently active/selected. If not, don't nag about updates.
        const currentEnvName = this.getCurrentEnvName();
        if (!currentEnvName) {
            return false;
        }

        // Even if 'default' is selected by fallback, prompt only if the folder exists.
        // This implies the user hasn't created/installed the environment yet.
        const envPath = path.join(workspaceUri.fsPath, '.pixi', 'envs', currentEnvName);
        if (!fs.existsSync(envPath)) {
            return false;
        }

        const pixiPath = this._pixiManager.getPixiPath();
        if (!pixiPath) { return false; }

        this.isChecking = true;
        try {
            this.log('Checking environment status (pixi lock --check)...');
            // Check if lockfile is consistent with manifest
            // 'pixi lock --check' returns non-zero if out of sync
            await this._exec(`"${pixiPath}" lock --check`, { cwd: workspaceUri.fsPath });

            // If check pass...
            this.log('Environment is in sync (manifest matches lockfile).');

            // BUT, if the lockfile itself changed (e.g. git stash, pull), the INSTALLED environment might be stale.
            // If NOT updating (self), and lockfile changed, prompt user.
            if (changedFile && changedFile.endsWith('pixi.lock') && !this.isUpdating) {
                this.log(`Lockfile changed externally (${changedFile}). Environment might be stale despite lock consistency.`);
                throw new Error("Lockfile changed");
            }

            return false;
        } catch {
            // If failed, it means out of sync (or error)
            this.log(`Environment out of sync (pixi lock --check failed).`);

            if (silent) { return false; }

            const selection = await vscode.window.showInformationMessage(
                "Pixi environment is out of sync. Do you want to update?",
                "Yes", "No", "Never ask again"
            );

            if (selection === "Yes") {
                const currentEnv = this.getCurrentEnvName();
                await this.activate(false, currentEnv);
                return true; // Activation handled
            } else if (selection === "Never ask again") {
                await config.update('disableConfigChangePrompt', true, vscode.ConfigurationTarget.Global);
                // User declined update. If "Never" is selected, prompting is disabled.
                // Auto-activation might still occur correctly.
            }
            // selection === "No" or dismissed
            this.log('User ignored update prompt.');
            return true; // User explicitely declined "Update". Check logic if auto-activate should still run.
        } finally {
            this.isChecking = false;
        }
    }

    private getSafeShellExecutionOptions(cwd: string): vscode.ShellExecutionOptions {
        // Explicitly specify the shell executable to avoid using the user's "Default Profile", which might be interactive.
        const shellExecutionOptions: vscode.ShellExecutionOptions = {
            cwd: cwd
        };

        // Use process.env.SHELL if available (User preference), otherwise fallback to safe defaults.
        if (process.env.SHELL) {
            shellExecutionOptions.executable = process.env.SHELL;
            // Most unix shells (bash, zsh, sh) use -c.
            // PowerShell on Linux uses -Command.
            if (process.env.SHELL.endsWith('pwsh') || process.env.SHELL.endsWith('powershell')) {
                shellExecutionOptions.shellArgs = ['-Command'];
            } else {
                shellExecutionOptions.shellArgs = ['-c'];
            }
        } else if (process.platform !== 'win32') {
            shellExecutionOptions.executable = '/bin/bash';
            shellExecutionOptions.shellArgs = ['-c'];
        } else {
            shellExecutionOptions.executable = 'powershell.exe';
            shellExecutionOptions.shellArgs = ['-Command'];
        }
        return shellExecutionOptions;
    }
}

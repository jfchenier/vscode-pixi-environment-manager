import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PixiManager } from './pixi';

export class EnvironmentManager {
    private _pixiManager: PixiManager;
    private _context: vscode.ExtensionContext;
    private _exec: (command: string, options?: any) => Promise<{ stdout: string, stderr: string }>;
    private _outputChannel: vscode.OutputChannel | undefined;
    private _terminalListener: vscode.Disposable | undefined;
    private _statusBarItem: vscode.StatusBarItem;
    private static readonly envStateKey = 'pixiSelectedEnvironment';

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

    private log(message: string) {
        if (this._outputChannel) {
            this._outputChannel.appendLine(message);
        }
    }

    private updateStatusBar(envName?: string) {
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


    private async getEnvironments(): Promise<string[]> {
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
                return info.environments_info
                    .map((e: any) => e.name)
                    .filter((n: string) => n !== 'default');
            }
            return [];
        } catch (e) {
            console.error("Failed to get environments info", e);
            return [];
        }
    }

    public async autoActivate() {
        let savedEnv = this._context.workspaceState.get<string>(EnvironmentManager.envStateKey);
        this.log(`AutoActivate: Saved state is '${savedEnv}'`);

        // If no saved environment from a previous session, check user configuration
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
                    // If no environments were found (e.g., fresh checkout, no lockfile, pixi info failed),
                    // but a default is configured, trust the configuration and attempt activation.
                    // This allows 'pixi install' to run naturally during activation.
                    savedEnv = defaultEnv;
                    this.log(`AutoActivate: No environments discovered. Trusting configured default '${defaultEnv}' and proceeding.`);

                    // Ensure pixi binary exists before attempting install/activate in this fresh scenario
                    try {
                        await this._pixiManager.ensurePixi();
                    } catch (e) {
                        this.log(`AutoActivate: Failed to ensure pixi binary: ${e}`);
                    }

                    // Force install because we know it's a fresh/empty state.
                    // Also pass silent=false so the user gets the Reload Window prompt after this heavy operation.
                    await this.doActivate(savedEnv, false, true);
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
            // Wait, this.activate() reads from state. So we need to set state IF we found a default env but no saved env.
            // Actually, let's look at activate(). It reads state.
            // So if we found a defaultEnv, we should probably set the state or call doActivate directly.
            // If we set state, it persists, which might annoy the user if they want to "unset" it.
            // But if we don't set state, activate() won't pick it up unless we pass it.
            // Let's rely on doActivate logic.
            // If we have a savedEnv (either from state or config), we update state? 
            // The user requested: "automatically create and activate this default environment without any manual intervension".
            // If I set workspaceState, it effectively "locks" it until they manually change it. 
            // That seems correct for "persistence".

            if (savedEnv !== this._context.workspaceState.get<string>(EnvironmentManager.envStateKey)) {
                await this._context.workspaceState.update(EnvironmentManager.envStateKey, savedEnv);
            }

            // Call the main activate method which handles Offline vs Online and Caching
            await this.activate(true);
        }
    }

    private static readonly cachedEnvKey = 'pixi.cachedEnv';

    private async doActivate(envName: string, silent: boolean, forceInstall: boolean = false) {

        const workspaceUri = this.getWorkspaceFolderURI();
        if (!workspaceUri) { return; }

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
            // Use --json to get the resolved environment variables directly
            // This handles activation scripts that might source other files or run commands
            const cmd = `"${pixiPath}" shell-hook --json${envName ? ` -e "${envName}"` : ''}`;

            this.log(`Activating environment: ${envName || 'default'} with command: ${cmd}`);

            // Show progress (less confusing title now)
            const location = silent ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification;
            const title = "Activating Pixi Environment (syncing)...";

            const { stdout, stderr } = await vscode.window.withProgress({
                location,
                title,
                cancellable: false
            }, async () => {
                return await this._exec(cmd, {
                    cwd: workspaceUri.fsPath
                });
            });

            // Log stderr (where script output usually goes) to output channel
            if (stderr && stderr.trim().length > 0) {
                this.log(`Activation Script Output:\n${stderr}`);
                // Also show to user if not silent? Maybe too noisy. 
                // Pixi usually prints activation info to stderr.
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

            // Apply to VSCode environment (terminals)
            const collection = this._context.environmentVariableCollection;
            const envUpdates = new Map<string, { value: string, op: 'replace' | 'prepend' | 'append' }>();

            for (const key in envVars) {
                const value = envVars[key];
                // JSON output gives the *final* value. We use 'replace' to set the state exactly as Pixi intended.
                envUpdates.set(key, { value, op: 'replace' });
            }

            for (const [key, update] of envUpdates) {
                let { value, op } = update;
                // op is always 'replace' now with JSON strategy

                // We still ensure local pixi bin is in PATH just in case, though it should be in JSON.
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
                    // We use PROMPT_COMMAND to run once then self-destruct mechanism (sort of).
                    // Actually simplest is: print if var set, then unset var.
                    this._context.environmentVariableCollection.replace('PIXI_ACTIVATION_MSG', msg);
                    // Prepend ensures it runs before other prompts (or use append?)
                    // PROMPT_COMMAND is bash.
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

    private async runInstallInTerminal(pixiPath: string, workspaceUri: vscode.Uri, envName?: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const taskDefinition = {
                type: 'pixi',
                task: 'install'
            };

            const installCmd = `"${pixiPath}" install${envName ? ` -e "${envName}"` : ''}`;

            // To satisfy user request to see activation script output (echoes) in the terminal:
            // We chain `pixi shell-hook` after install.
            // We redirect stdout to /dev/null (Linux/Mac) or NUL (Windows) to suppress the huge JSON/Export dump,
            // leaving only stderr (where echo usually goes or where Pixi logs info).
            let shellHookCmd = '';
            // We use a simple echo for the "Executing..." message.
            // Note: We avoid `this.log` as explicitly requested by USER.

            const msg = `Executing Pixi Task: ${installCmd}`;
            let fullCommand = '';

            if (process.platform === 'win32') {
                // Windows (CMD vs PowerShell is ambiguous in ShellExecution without explicit executable)
                // We'll try to keep it simple. If we can't reliably chain output suppression, 
                // we might skip the shell-hook viz or try a generic approach.
                // Assuming Powershell is common default:
                // cmd; shell-hook | Out-Null
                // But users might use CMD.
                // Let's focus on the `echo` requirement primarily if shell-hook is too risky on Windows.
                // But specifically for Linux (User's OS), we can do it standard.
                fullCommand = `echo '${msg}' ; ${installCmd}`;
            } else {
                // Linux/Mac: standard bash-like syntax
                // IMPORTANT: We must EVAL the output of shell-hook to actually RUN the activation scripts (e.g. source activate.sh)
                // which produces the output ('echo') the user wants to see. 
                // Redirecting to /dev/null just discarded the script without running it.
                shellHookCmd = ` && eval "$("${pixiPath}" shell-hook${envName ? ` -e "${envName}"` : ''})"`;
                fullCommand = `echo '${msg}' && ${installCmd}${shellHookCmd}`;
            }

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
            vscode.tasks.executeTask(task).then(execution => {
                const disposable = vscode.tasks.onDidEndTaskProcess(e => {
                    if (e.execution === execution) {
                        disposable.dispose();
                        if (e.exitCode === 0) {
                            resolve();
                        } else {
                            reject(new Error(`Pixi install failed with exit code ${e.exitCode}`));
                        }
                    }
                });
            }, error => {
                reject(new Error(`Failed to start task: ${error}`));
            });
        });
    }

    public async deactivate(silent: boolean = false) {
        // Clear saved state
        await this._context.workspaceState.update(EnvironmentManager.envStateKey, undefined);
        // Clear the offline cache so it doesn't auto-resurrect on reload
        await this._context.workspaceState.update(EnvironmentManager.cachedEnvKey, undefined);

        // Reset configuration to default if it was set to the offline env
        const config = vscode.workspace.getConfiguration('pixi');
        const offlineName = config.get<string>('offlineEnvironmentName', 'env');
        const currentConfigEnv = config.get<string>('environment');

        if (currentConfigEnv === offlineName) {
            await config.update('environment', undefined, vscode.ConfigurationTarget.Workspace);
        }

        // Clear environment variables
        // When EXPLICITLY deactivating, we DO want to clear them.
        // The previous logic to NOT clear was for "closing window but keeping state".
        // But "Pixi: Deactivate" means "Stop using this Env".
        this._context.environmentVariableCollection.clear();

        if (!silent) {
            const autoReload = config.get<boolean>('autoReload');

            if (autoReload) {
                vscode.window.showInformationMessage("Environment deactivated. Reloading window...");
                vscode.commands.executeCommand("workbench.action.reloadWindow");
            } else {
                // Prompt for reload
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
        if (!this.getWorkspaceFolderURI()) {
            vscode.window.showErrorMessage('No workspace open.');
            return;
        }

        const workspaceRoot = this.getWorkspaceFolderURI()!.fsPath;
        const pixiPath = this._pixiManager.getPixiPath();

        if (!pixiPath) {
            vscode.window.showErrorMessage('Pixi executable not found.');
            return;
        }

        try {
            // 1. Install pixi-pack in default environment
            // Check if installed first? `pixi list`? Or just run add (it's idempotent usually)
            // But `add` might modify pixi.toml.
            // User explicit request: "That install pixi-pack in the default environment"
            this.log('Ensuring pixi-pack is installed in default environment...');
            await this.runInstallInTerminal(pixiPath, this.getWorkspaceFolderURI()!, undefined); // Ensure env is built

            // We need to add it: `pixi add pixi-pack`
            // But we should probably check if it's already there to avoid unnecessary edits/re-locks.
            // Let's just run it. If it's already there, it's fast.
            // Wait, running `pixi add` creates a lockfile update.
            // If I just run `pixi add pixi-pack`, it adds it to `default` dependencies.

            // To be safe and show progress:
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Installing pixi-pack...",
                cancellable: false
            }, async () => {
                await this._exec(`"${pixiPath}" add pixi-pack`, { cwd: workspaceRoot });
            });


            // 2. Select Environment
            const envs = await this.getEnvironments();
            if (envs.length === 0) {
                vscode.window.showErrorMessage('No environments found to pack.');
                return;
            }

            const selectedEnv = await vscode.window.showQuickPick(envs, {
                placeHolder: 'Select Environment to Pack'
            });

            if (!selectedEnv) return;

            // 3. Select Platform
            const platforms = await this.getProjectPlatforms(workspaceRoot);
            if (platforms.length === 0) {
                // Fallback or error? pixi.toml must have platforms usually.
                // If not, maybe use current?
                const currentPlatform = process.platform === 'win32' ? 'win-64' : (process.platform === 'darwin' ? 'osx-64' : 'linux-64'); // Simplified
                platforms.push(currentPlatform);
            }

            const selectedPlatform = await vscode.window.showQuickPick(platforms, {
                placeHolder: 'Select Target Platform'
            });

            if (!selectedPlatform) return;

            // 4. Execute Generation Command
            // Use vscode.Task for consistent terminal behavior
            const cmd = `"${pixiPath}" exec pixi-pack --environment ${selectedEnv} --platform ${selectedPlatform} pixi.toml --create-executable`;

            // We must explicitly specify the shell executable to avoid using the user's "Default Profile".
            const shellExecutionOptions = this.getSafeShellExecutionOptions(workspaceRoot);

            await new Promise<void>((resolve, reject) => {
                const taskDefinition = {
                    type: 'pixi',
                    task: 'pack'
                };

                const task = new vscode.Task(
                    taskDefinition,
                    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspaceRoot)) || vscode.TaskScope.Workspace,
                    `Pack ${selectedEnv}`,
                    'pixi',
                    new vscode.ShellExecution(cmd, shellExecutionOptions),
                    []
                );

                task.presentationOptions = {
                    reveal: vscode.TaskRevealKind.Always,
                    panel: vscode.TaskPanelKind.Dedicated,
                    clear: true,
                    close: false
                };

                vscode.tasks.executeTask(task).then(execution => {
                    const disposable = vscode.tasks.onDidEndTaskProcess(e => {
                        if (e.execution === execution) {
                            disposable.dispose();
                            if (e.exitCode === 0) {
                                resolve();
                            } else {
                                reject(new Error(`Pack failed with exit code ${e.exitCode}`));
                            }
                        }
                    });
                }, error => {
                    reject(new Error(`Failed to start pack task: ${error}`));
                });
            });

            vscode.window.showInformationMessage(`Offline environment generated for ${selectedEnv} (${selectedPlatform}).`);

        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to generate offline environment: ${e.message}`);
        }
    }

    private async getProjectPlatforms(workspaceRoot: string): Promise<string[]> {
        try {
            const tomlPath = path.join(workspaceRoot, 'pixi.toml');
            if (fs.existsSync(tomlPath)) {
                const content = await fs.promises.readFile(tomlPath, 'utf8');
                // Simple regex to find platforms = ["..."] or platforms = [...]
                // Supports spanning multiple lines? TOML arrays can.
                // Let's try to match `platforms` key.
                const match = content.match(/platforms\s*=\s*\[(.*?)\]/s); // s flag for dotAll
                if (match && match[1]) {
                    // Extract strings
                    const inner = match[1];
                    // Split by comma
                    const parts = inner.split(',');
                    return parts.map(p => p.trim().replace(/['"]/g, '')).filter(p => p.length > 0);
                }
            }
        } catch (e) {
            console.error("Failed to parse platforms", e);
        }
        return [];
    }

    public async clearEnvironment() {
        if (!this.getWorkspaceFolderURI()) {
            vscode.window.showErrorMessage('No workspace open.');
            return;
        }

        const answer = await vscode.window.showWarningMessage(
            "Are you sure you want to clear the environment? This will deactivate the current environment AND delete the '.pixi' directory.",
            "Yes", "No"
        );

        if (answer !== 'Yes') {
            return;
        }

        try {
            // 1. Deactivate
            await this.deactivate(true); // Silent deactivate

            // 2. Delete .pixi directory
            const workspacePath = this.getWorkspaceFolderURI()!.fsPath;
            const pixiDir = path.join(workspacePath, '.pixi');

            if (fs.existsSync(pixiDir)) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Clearing Pixi Environment...",
                    cancellable: false
                }, async () => {
                    await fs.promises.rm(pixiDir, { recursive: true, force: true });
                });

                vscode.window.showInformationMessage("'.pixi' directory deleted.");
                // 3. Reload window to clear all traces
                vscode.commands.executeCommand("workbench.action.reloadWindow");
            } else {
                vscode.window.showInformationMessage("'.pixi' directory does not exist.");
            }

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to clear environment: ${error.message}`);
        }
    }

    public async generateActivationScripts(workspaceUri: vscode.Uri) {
        const platform = process.platform;

        // Generate activate.sh for bash/zsh (Linux/macOS)
        // We always generate the sh script as it might be useful even on Windows (WSL/Git Bash)
        const shPath = path.join(workspaceUri.fsPath, 'activate.sh');
        if (!fs.existsSync(shPath)) {
            const shContent = `#!/bin/sh
# Activation script generated by Pixi VS Code Extension

# Detect shell
if [ -n "$ZSH_VERSION" ]; then
    _PIXI_SHELL="zsh"
elif [ -n "$BASH_VERSION" ]; then
    _PIXI_SHELL="bash"
else
    _PIXI_SHELL="bash" # Default to bash
fi

if [ -n "$1" ]; then
    _TARGET_ENV="$1"
else
    # Auto-select logic
    _ENVS=$("$PWD/.pixi/bin/pixi" info | grep "Environment:" | awk '{print $2}' | grep -v "^default$")
    _COUNT=$(echo "$_ENVS" | grep -c .)
    
    if [ "$_COUNT" -eq "1" ]; then
        _TARGET_ENV="$_ENVS"
    elif [ -z "$_ENVS" ]; then
        # Only default exists
        _TARGET_ENV=""
    else
        echo "Usage: source activate.sh <environment_name>"
        echo "Available environments:"
        echo "$_ENVS"
        return 1 2>/dev/null || exit 1
    fi
fi

export PATH="$PWD/.pixi/bin:$PATH"
if [ -n "$_TARGET_ENV" ]; then
    eval "$(pixi shell-hook --shell $_PIXI_SHELL -e "$_TARGET_ENV")"
else
    eval "$(pixi shell-hook --shell $_PIXI_SHELL)"
fi
unset _PIXI_SHELL
unset _TARGET_ENV
unset _ENVS
unset _COUNT
`;
            try {
                await fs.promises.writeFile(shPath, shContent, { mode: 0o755 });
                this.log(`Created ${shPath}`);
            } catch (e) {
                console.error(`Failed to create activate.sh: ${e}`);
            }
        }

        // Generate activate.bat for Windows CMD
        // Also useful if user is on Windows
        const batPath = path.join(workspaceUri.fsPath, 'activate.bat');
        if (!fs.existsSync(batPath)) {
            const batContent = `@echo off
rem Activation script generated by Pixi VS Code Extension

set "SCRIPT_DIR=%~dp0"

if not "%~1"=="" (
    set "_TARGET_ENV=%~1"
    goto :activate
)

REM Auto-select logic
set _COUNT=0
set _LAST_ENV=

for /f "tokens=2" %%i in ('call "%SCRIPT_DIR%.pixi\\bin\\pixi" info ^| findstr "Environment:"') do (
    if not "%%i"=="default" (
        set /a _COUNT+=1
        set "_LAST_ENV=%%i"
    )
)

if "%_COUNT%"=="1" (
    set "_TARGET_ENV=%_LAST_ENV%"
    goto :activate
)

if "%_COUNT%"=="0" (
    REM Only default exists
    set "_TARGET_ENV="
    goto :activate
)

echo Usage: activate.bat ^<environment_name^>
echo Available environments:
for /f "tokens=2" %%i in ('call "%SCRIPT_DIR%.pixi\\bin\\pixi" info ^| findstr "Environment:"') do (
     if not "%%i"=="default" echo %%i
)
exit /b 1

:activate
set "PATH=%SCRIPT_DIR%.pixi\\bin;%PATH%"

set "_TEMP_SCRIPT=%TEMP%\\pixi_env_%RANDOM%.bat"

if not "%_TARGET_ENV%"=="" (
    call pixi shell-hook --shell cmd -e "%_TARGET_ENV%" > "%_TEMP_SCRIPT%"
) else (
    call pixi shell-hook --shell cmd > "%_TEMP_SCRIPT%"
)

if exist "%_TEMP_SCRIPT%" (
    call "%_TEMP_SCRIPT%"
    del "%_TEMP_SCRIPT%"
)

set "_TARGET_ENV="
set "_COUNT="
set "_LAST_ENV="
set "_TEMP_SCRIPT="
set "SCRIPT_DIR="
`;
            try {
                await fs.promises.writeFile(batPath, batContent);
                this.log(`Created ${batPath}`);
            } catch (e) {
                console.error(`Failed to create activate.bat: ${e}`);
            }
        }
    }

    public async generateScripts() {
        if (!this.getWorkspaceFolderURI()) {
            vscode.window.showErrorMessage('No workspace open.');
            return;
        }
        const uri = this.getWorkspaceFolderURI()!;

        await this.generateActivationScripts(uri);
        await this.generateBootstrapScript(uri);

        vscode.window.showInformationMessage('Activation and Bootstrap scripts generated.');
    }

    public async generateBootstrapScript(workspaceUri: vscode.Uri) {
        // Linux/macOS bootstrap.sh
        const shPath = path.join(workspaceUri.fsPath, 'bootstrap.sh');
        if (!fs.existsSync(shPath)) {
            const shContent = `#!/bin/bash
# Bootstrap script generated by Pixi VS Code Extension
# Downloads Pixi if missing and activates the environment

# Safe exit function (handles sourcing vs execution)
die() {
    echo "$1"
    # Check if sourced (Zsh vs Bash)
    if [[ -n "$ZSH_VERSION" ]]; then
       if [[ -o interactive ]]; then return 1; else exit 1; fi
    elif [[ "\${BASH_SOURCE[0]}" != "\${0}" ]]; then
        return 1
    else
        exit 1
    fi
}

BASE_URL="https://github.com/prefix-dev/pixi/releases/latest/download"
PIXI_DIR=".pixi/bin"
PIXI_BIN="$PIXI_DIR/pixi"

OS=$(uname -s)
ARCH=$(uname -m)

if [ "$OS" = "Linux" ]; then
    if [ "$ARCH" = "x86_64" ]; then
        TARGET="x86_64-unknown-linux-musl"
    elif [ "$ARCH" = "aarch64" ]; then
        TARGET="aarch64-unknown-linux-musl"
    else
        die "Unsupported architecture: $ARCH"
    fi
    EXT="tar.gz"
elif [ "$OS" = "Darwin" ]; then
    if [ "$ARCH" = "x86_64" ]; then
        TARGET="x86_64-apple-darwin"
    elif [ "$ARCH" = "arm64" ]; then
        TARGET="aarch64-apple-darwin"
    else
        die "Unsupported architecture: $ARCH"
    fi
    EXT="tar.gz"
else
    die "Unsupported OS: $OS"
fi

if [ ! -f "$PIXI_BIN" ]; then
    echo "Pixi not found in $PIXI_BIN"
    mkdir -p "$PIXI_DIR"
    
    URL="$BASE_URL/pixi-$TARGET.$EXT"
    echo "Downloading from $URL..."
    
    if command -v curl >/dev/null 2>&1; then
        curl -L -o "pixi.$EXT" "$URL" || die "Download failed"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "pixi.$EXT" "$URL" || die "Download failed"
    else
        die "Error: curl or wget required to download pixi."
    fi

    echo "Extracting..."
    tar -xzf "pixi.$EXT" -C "$PIXI_DIR" || die "Extraction failed"
    
    if [ ! -f "$PIXI_BIN" ]; then
       FOUND=$(find "$PIXI_DIR" -name pixi -type f | head -n 1)
       if [ -n "$FOUND" ]; then
           mv "$FOUND" "$PIXI_BIN"
       fi
    fi

    if [ ! -f "$PIXI_BIN" ]; then
        die "Pixi binary not found after extraction"
    fi

    chmod +x "$PIXI_BIN"
    rm "pixi.$EXT"
    echo "Pixi installed."
fi

# Delegate to activate.sh
if [ -f "./activate.sh" ]; then
    . ./activate.sh
else
    die "activate.sh not found!"
fi

# Check if sourced or executed (Zsh vs Bash)
_IS_SOURCED=0
if [[ -n "$ZSH_VERSION" ]]; then
   if [[ -o interactive ]]; then _IS_SOURCED=1; fi
elif [[ "\${BASH_SOURCE[0]}" != "\${0}" ]]; then
   _IS_SOURCED=1
fi

if [ "$_IS_SOURCED" = "0" ]; then
    echo "Bootstrap complete. Starting shell..."
    exec "\${SHELL:-/bin/bash}"
fi
`;
            try {
                await fs.promises.writeFile(shPath, shContent, { mode: 0o755 });
                this.log(`Created ${shPath}`);
            } catch (e) {
                console.error(`Failed to create bootstrap.sh: ${e}`);
            }
        }

        // Windows bootstrap.bat (Calls PowerShell for download)
        const batPath = path.join(workspaceUri.fsPath, 'bootstrap.bat');
        if (!fs.existsSync(batPath)) {
            const batContent = `@echo off
setlocal EnableDelayedExpansion

REM Bootstrap script generated by Pixi VS Code Extension

set "BASE_URL=https://github.com/prefix-dev/pixi/releases/latest/download"
set "SCRIPT_DIR=%~dp0"
set "PIXI_DIR=%SCRIPT_DIR%.pixi\\bin"
set "PIXI_BIN=%PIXI_DIR%\\pixi.exe"
set "TARGET=x86_64-pc-windows-msvc"
set "ZIP_FILE=%SCRIPT_DIR%pixi.zip"

if not exist "%PIXI_BIN%" (
    echo Pixi not found.
    if not exist "%PIXI_DIR%" mkdir "%PIXI_DIR%"

    echo Downloading %BASE_URL%/pixi-%TARGET%.zip ...
    powershell -NoProfile -Command "$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '%BASE_URL%/pixi-%TARGET%.zip' -OutFile '%ZIP_FILE%'"
    
    if exist "%ZIP_FILE%" (
        echo Extracting...
        powershell -NoProfile -Command "Expand-Archive -Path '%ZIP_FILE%' -DestinationPath '%PIXI_DIR%' -Force"
        del "%ZIP_FILE%"
    ) else (
        echo Failed to download pixi.zip
        exit /b 1
    )
    
    if not exist "%PIXI_BIN%" (
        echo Checking for nested pixi.exe...
        for /r "%PIXI_DIR%" %%F in (pixi.exe) do (
            move /y "%%F" "%PIXI_BIN%"
        )
    )

    if not exist "%PIXI_BIN%" (
        echo Error: pixi.exe still not found.
        exit /b 1
    )
    
    echo Pixi installed.
)

endlocal

if exist "%SCRIPT_DIR%activate.bat" (
    call "%SCRIPT_DIR%activate.bat" %*
) else (
    echo activate.bat not found.
    exit /b 1
)
`;
            try {
                await fs.promises.writeFile(batPath, batContent);
                this.log(`Created ${batPath}`);
            } catch (e) {
                console.error(`Failed to create bootstrap.bat: ${e}`);
            }
        }
    }


    public async loadOfflineEnvironment() {
        if (!this.getWorkspaceFolderURI()) {
            vscode.window.showErrorMessage('No workspace open.');
            return;
        }
        const workspaceRoot = this.getWorkspaceFolderURI()!.fsPath;

        // 1. Show File Picker
        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'Shell Script': ['sh', 'ps1', 'bat']
            },
            title: 'Select Environment Activation Script'
        });

        if (!uri || uri.length === 0) {
            return;
        }

        const scriptPath = uri[0].fsPath;

        // 2. Prepare Target Directory
        const config = vscode.workspace.getConfiguration('pixi');
        const envName = config.get<string>('offlineEnvironmentName', 'env');
        const envsDir = path.join(workspaceRoot, '.pixi', 'envs');
        const targetEnvDir = path.join(envsDir, envName);

        // Ensure envs directory exists
        fs.mkdirSync(envsDir, { recursive: true });

        // Clean target directory to ensure fresh install
        if (fs.existsSync(targetEnvDir)) {
            try {
                fs.rmSync(targetEnvDir, { recursive: true, force: true });
            } catch (e) {
                console.warn("Failed to clean target dir", e);
            }
        }

        // 3. Execute Script to Unpack
        try {
            const platform = process.platform;
            let cmd = '';

            // User requested: script.sh --env-name <name> --output-directory <envs_dir>
            // We use absolute paths for arguments.

            if (platform === 'win32') {
                if (scriptPath.endsWith('.ps1')) {
                    const scriptPathSafe = scriptPath.replace(/'/g, "''");
                    const envNameSafe = envName.replace(/'/g, "''");
                    const envsDirSafe = envsDir.replace(/'/g, "''");
                    cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command { & '${scriptPathSafe}' --env-name '${envNameSafe}' --output-directory '${envsDirSafe}' }`;
                } else if (scriptPath.endsWith('.sh')) {
                    const scriptPathPosix = scriptPath.split(path.sep).join(path.posix.sep);
                    const envsDirPosix = envsDir.split(path.sep).join(path.posix.sep);
                    cmd = `bash "${scriptPathPosix}" --env-name "${envName}" --output-directory "${envsDirPosix}"`;
                } else {
                    // .bat?
                    cmd = `cmd /c "call "${scriptPath}" --env-name "${envName}" --output-directory "${envsDir}""`;
                }
            } else {
                cmd = `bash "${scriptPath}" --env-name "${envName}" --output-directory "${envsDir}"`;
            }

            // Run via Task
            const shellExecutionOptions = this.getSafeShellExecutionOptions(workspaceRoot);

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Unpacking offline environment...",
                cancellable: false
            }, async (progress) => {
                progress.report({ message: "This may take some time." });

                await new Promise<void>((resolve, reject) => {
                    const taskDefinition = {
                        type: 'pixi',
                        task: 'unpack'
                    };

                    const task = new vscode.Task(
                        taskDefinition,
                        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspaceRoot)) || vscode.TaskScope.Workspace,
                        `Unpack ${envName}`,
                        'pixi',
                        new vscode.ShellExecution(cmd, shellExecutionOptions),
                        []
                    );

                    task.presentationOptions = {
                        reveal: vscode.TaskRevealKind.Always,
                        panel: vscode.TaskPanelKind.Dedicated,
                        clear: true,
                        close: false
                    };

                    vscode.tasks.executeTask(task).then(execution => {
                        const disposable = vscode.tasks.onDidEndTaskProcess(e => {
                            if (e.execution === execution) {
                                disposable.dispose();
                                if (e.exitCode === 0) {
                                    resolve();
                                } else {
                                    reject(new Error(`Unpack failed with exit code ${e.exitCode}`));
                                }
                            }
                        });
                    }, error => {
                        reject(new Error(`Failed to start unpack task: ${error}`));
                    });
                });
            });

            vscode.window.showInformationMessage(`Offline environment unpacked to ${targetEnvDir}`);

            // Find env script
            await this.activateOfflineEnvironment(targetEnvDir, envName, true);

            // Update state
            await this._context.workspaceState.update(EnvironmentManager.envStateKey, envName);
            await this.activate(true);

            // Check auto-reload config
            const autoReload = vscode.workspace.getConfiguration('pixi').get<boolean>('autoReload');

            if (autoReload) {
                vscode.window.showInformationMessage("Offline environment loaded. Reloading window...");
                vscode.commands.executeCommand("workbench.action.reloadWindow");
            } else {
                // Ask to reload window
                const selection = await vscode.window.showInformationMessage(
                    "Offline environment loaded. Reload window to apply changes?",
                    "Reload"
                );
                if (selection === "Reload") {
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
            }

        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to unpack/install offline environment: ${e.message}`);
        }
    }

    public async activate(silent: boolean = false): Promise<void> {
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

            // --- CACHE VARS ---
            if (currentEnv === offlineName) {
                const cached = this._context.workspaceState.get<any>(EnvironmentManager.cachedEnvKey);
                if (cached && cached.envName === offlineName && cached.envVars) {
                    this.log(`Found cached environment for '${offlineName}'. Applying instantaneously.`);
                    for (const key in cached.envVars) {
                        if (key === 'TERM' || key === 'TERMINFO' || key === 'TERMINFO_DIRS') continue; // Skip terminal vars
                        const value = cached.envVars[key];
                        process.env[key] = value;
                        this._context.environmentVariableCollection.replace(key, value);
                    }
                }
            }
            // ------------------

            // Only auto-activate offline directly if running silently (startup)
            // If manual (!silent), we want to show the picker if other envs exist.
            if (silent && currentEnv === offlineName && workspaceRoot) {
                const envDir = path.join(workspaceRoot, '.pixi', 'envs', offlineName);
                if (fs.existsSync(envDir)) {
                    this.log(`Offline env found. Activating...`);
                    const handled = await this.activateOfflineEnvironment(envDir, offlineName, silent);
                    if (handled) {
                        return;
                    }
                }
                // If offline configured but not found, warn? Or fall through?
                // If we fell through (handled == false), it means script missing.
                // Fall through to standard check.
                // Let's warn if silent is false, then fall through.
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
                            const handled = await this.activateOfflineEnvironment(envDir, offlineName, silent);
                            if (handled) return;
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
                        const handled = await this.activateOfflineEnvironment(envDir, offlineName, silent);
                        if (handled) return;
                    }
                    // If not handled, fall through to return
                }
            }

            this.log(`Pixi executable not found.`);
            // Only error if we failed offline AND missed pixi
            if (!silent) {
                vscode.window.showErrorMessage("Pixi not installed and offline environment not found.");
            }
            return;
        }

        const envs = await this.getEnvironments();
        // Add offline environment to candidates if available and not already listed
        if (offlineAvailable && !envs.includes(offlineName)) {
            envs.push(offlineName);
        }

        let selectedEnv = '';

        if (!silent && envs.length > 0) {
            const pick = await vscode.window.showQuickPick(envs, {
                placeHolder: 'Select Pixi Environment to Activate'
            });
            if (!pick) { return; }
            selectedEnv = pick;
        } else {
            // Silent or Auto-selection Logic
            // 1. Try to use currently configured/saved environment
            if (currentEnv && (envs.includes(currentEnv) || currentEnv === 'default')) {
                selectedEnv = currentEnv;
            }
            // 2. Fallback: Pick the first available (non-default) environment if multiple exist
            else if (envs.length > 0) {
                selectedEnv = envs[0];
                // If the filtered list implies default, we handled it, but here we just pick first.
            }
        }

        if (selectedEnv) {
            await this._context.workspaceState.update(EnvironmentManager.envStateKey, selectedEnv);

            // If offline selected, trigger offline logic explicitly
            if (selectedEnv === offlineName) {
                if (workspaceRoot) {
                    const envDir = path.join(workspaceRoot, '.pixi', 'envs', offlineName);
                    const handled = await this.activateOfflineEnvironment(envDir, offlineName, silent);
                    if (handled) return;
                }
                // If not handled (return false), it means script missing.
                // Fall through to doActivate to try standard activation for this name.
            }
        }

        await this.doActivate(selectedEnv, silent);
    }

    // ... (rest of methods)

    private async activateOfflineEnvironment(envDir: string, envName: string, silent: boolean = false): Promise<boolean> {
        // Find activation script. User specifies it resides in the parent directory (e.g. .pixi/envs/activate.sh)
        // rather than inside the specific environment folder.
        let scriptPath = '';

        const candidates = [path.dirname(envDir)];

        for (const dir of candidates) {
            if (process.platform === 'win32') {
                if (fs.existsSync(path.join(dir, 'activate.bat'))) { scriptPath = path.join(dir, 'activate.bat'); break; }
                else if (fs.existsSync(path.join(dir, 'activate.ps1'))) { scriptPath = path.join(dir, 'activate.ps1'); break; }
            } else {
                if (fs.existsSync(path.join(dir, 'activate.sh'))) { scriptPath = path.join(dir, 'activate.sh'); break; }
            }
        }

        if (!scriptPath) {
            // Fallback: If no script found, return false to let caller handle regular activation (or error)
            return false;
        }

        this.log(`Activating offline environment '${envName}' using ${scriptPath}`);

        try {
            // Fix cwd to be the script's directory, ensuring relative paths in script work
            const scriptDir = path.dirname(scriptPath);

            // Sanitize environment for the Diff determination
            const runEnv = { ...process.env };
            const cached = this._context.workspaceState.get<any>(EnvironmentManager.cachedEnvKey);

            if (cached && cached.envName === envName && cached.envVars) {
                this.log('Sanitizing environment for diff calculation (removing cached vars from baseline).');
                for (const key in cached.envVars) {
                    // Do not delete PATH as it might break shell execution
                    if (key !== 'PATH') {
                        delete runEnv[key];
                    }
                }
            }

            const platform = process.platform;
            let cmd = '';

            // Using unique separator
            const separator = '___PIXI_VSCODE_SEPARATOR___';

            if (platform === 'win32') {
                if (scriptPath.endsWith('.ps1')) {
                    // Powershell diff
                    const dumpEnv = `Get-ChildItem Env: | ForEach-Object {Write-Output \\\"$($_.Name)=$($_.Value)\\\"}`;
                    cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${dumpEnv}; Write-Output '${separator}'; & '${scriptPath}'; ${dumpEnv}"`;
                } else {
                    // Batch
                    cmd = `cmd /c "set && echo ${separator} && call "${scriptPath}" && set"`;
                }
            } else {
                // Bash
                cmd = `/bin/bash -c "printenv && echo '${separator}' && source \\"${scriptPath}\\" && printenv"`;
            }

            const { stdout } = await this._exec(cmd, { cwd: scriptDir, env: runEnv });

            // Split by separator
            const parts = stdout.split(separator);
            if (parts.length < 2) {
                throw new Error("Failed to capture environment diff (separator not found).");
            }

            const parseEnv = (output: string) => {
                const map = new Map<string, string>();
                const lines = output.split('\n');
                for (const line of lines) {
                    const idx = line.indexOf('=');
                    if (idx > 0) {
                        const key = line.substring(0, idx).trim();
                        const value = line.substring(idx + 1).trim();
                        if (key) map.set(key, value);
                    }
                }
                return map;
            };

            const beforeEnv = parseEnv(parts[0]);
            const afterEnv = parseEnv(parts[1]);
            const envUpdates = new Map<string, string>();

            for (const [key, value] of afterEnv) {
                const beforeValue = beforeEnv.get(key);
                // If new or changed
                if (value !== beforeValue) {
                    // Exclude irrelevant vars that might change naturally or break terminal
                    if (key === '_' || key === 'SHLVL' || key === 'PWD' || key === 'OLDPWD' || key === 'TERM' || key === 'TERMINFO' || key === 'TERMINFO_DIRS') continue;
                    envUpdates.set(key, value);
                }
            }

            this.log(`Applying ${envUpdates.size} environment updates from offline script.`);

            // Convert Map to Obj for caching
            const envObj: { [key: string]: string } = {};

            // 1. Apply Updates from Script
            // We assume the script provides correct paths now that we align with its structure.

            for (const [key, value] of envUpdates) {
                this.log(`UPDATE: ${key} = ${value}`);
                this._context.environmentVariableCollection.replace(key, value);
                process.env[key] = value;
                envObj[key] = value;
            }



            // Save to Cache
            this.log(`Caching environment '${envName}'`);
            await this._context.workspaceState.update(EnvironmentManager.cachedEnvKey, {
                envName: envName,
                envVars: envObj,
                timestamp: Date.now()
            });

            if (!silent) {
                vscode.window.showInformationMessage(`Offline environment '${envName}' activated.`);

                const config = vscode.workspace.getConfiguration('pixi');
                const autoReload = config.get<boolean>('autoReload');
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
            } else {
                console.log('Pixi environment activated silently.');
            }
            vscode.commands.executeCommand('setContext', 'pixi.isEnvironmentActive', true);
            this.updateStatusBar(envName || 'default');

        } catch (e: any) {
            this.updateStatusBar(envName);
            if (!silent) {
                vscode.window.showErrorMessage(`Failed to activate offline environment: ${e.message}`);
            }
            this.log(`Offline activation error: ${e.message}`);
        }
        return true;
    }



    private getSafeShellExecutionOptions(cwd: string): vscode.ShellExecutionOptions {
        // We must explicitly specify the shell executable to avoid using the user's "Default Profile".
        // If the user's default profile (settings.json) launches an interactive shell (e.g. `banner.sh; zsh`),
        // the task command might hang waiting for that interactive shell to exit or loop infinitely.
        // By specifying executable, we bypass the profile args.
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

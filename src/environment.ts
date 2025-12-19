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

        // Initial Context Check
        this.updatePixiContext();
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

            // Generate helper scripts
            await this.generateActivationScripts(this.getWorkspaceFolderURI()!);

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
            const platform = process.platform;
            const shellArg = platform === 'win32' ? 'powershell' : 'bash';
            const cmd = `"${pixiPath}" shell-hook --shell ${shellArg}${envName ? ` -e ${envName}` : ''}`;

            this.log(`Activating environment: ${envName || 'default'} with command: ${cmd}`);

            // Show progress (less confusing title now)
            const location = silent ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification;
            const title = "Activating Pixi Environment (syncing)...";

            const { stdout } = await vscode.window.withProgress({
                location,
                title,
                cancellable: false
            }, async () => {
                return await this._exec(cmd, {
                    cwd: workspaceUri.fsPath
                });
            });

            this.log(`Command output:\n${stdout}`);

            // Parse exports (bash) or PowerShell assignments
            const lines = stdout.split('\n');
            const envUpdates = new Map<string, { value: string, op: 'replace' | 'prepend' | 'append' }>();

            for (const line of lines) {
                const trimmed = line.trim();

                if (trimmed.startsWith('export ')) {
                    const firstEquals = trimmed.indexOf('=');
                    if (firstEquals === -1) continue;

                    const key = trimmed.substring(7, firstEquals);
                    let value = trimmed.substring(firstEquals + 1);

                    // Unquote
                    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.substring(1, value.length - 1);
                    }

                    envUpdates.set(key, { value, op: 'replace' });
                } else if (trimmed.startsWith('${Env:')) {
                    // PowerShell: ${Env:KEY} = "VAL" [ + $Env:KEY ]
                    // We just grab the whole right side first.
                    // The regex captures everything after assignment, excluding leading whitespace
                    const match = trimmed.match(/^\${Env:([^}]+)}\s*=\s*(.*)$/);
                    if (match) {
                        const key = match[1];
                        let rhs = match[2];
                        let op: 'replace' | 'prepend' | 'append' = 'replace';
                        let value = rhs;

                        // Check for Prepend: "VAL" + $Env:KEY
                        const prependSuffix = `+ $Env:${key}`;
                        if (value.endsWith(prependSuffix)) {
                            op = 'prepend';
                            value = value.substring(0, value.length - prependSuffix.length).trim();
                        } else {
                            // Check for Append: $Env:KEY + "VAL"
                            const appendPrefix = `$Env:${key} +`;
                            if (value.startsWith(appendPrefix)) {
                                op = 'append';
                                value = value.substring(appendPrefix.length).trim();
                            }
                        }

                        // Strip outer quotes if still present
                        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                            value = value.substring(1, value.length - 1);
                        }

                        envUpdates.set(key, { value, op });
                    }
                }
            }

            // Apply to VSCode environment (terminals)
            const collection = this._context.environmentVariableCollection;

            for (const [key, update] of envUpdates) {
                let { value, op } = update;

                if (key === 'PATH' && pixiPath) {
                    const pixiBinDir = path.dirname(pixiPath);
                    if (!value.includes(pixiBinDir)) {
                        // Always prepend local pixi bin to PATH if missing
                        if (op === 'replace') {
                            value = `${pixiBinDir}${path.delimiter}${value}`;
                        } else {
                            // If prepending, simpler to just add it to value
                            if (op === 'prepend') {
                                value = `${pixiBinDir}${path.delimiter}${value}`;
                            } else {
                                // op is append, prepend separately.
                                this._context.environmentVariableCollection.prepend(key, pixiBinDir + path.delimiter);
                            }
                        }
                    }
                }

                if (op === 'replace') {
                    this._context.environmentVariableCollection.replace(key, value);
                    process.env[key] = value;
                } else if (op === 'prepend') {
                    this._context.environmentVariableCollection.prepend(key, value);
                    // Best effort process.env update
                    process.env[key] = value + (process.env[key] || '');
                } else { // append
                    this._context.environmentVariableCollection.append(key, value);
                    process.env[key] = (process.env[key] || '') + value;
                }
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
            } else {
                console.log('Pixi environment activated silently.');
            }
            vscode.commands.executeCommand('setContext', 'pixi.isEnvironmentActive', true);

            // Setup Terminal Prompt Listener (Windows PowerShell specific workaround)
            if (process.platform === 'win32') {
                if (this._terminalListener) {
                    this._terminalListener.dispose();
                }
                this._terminalListener = vscode.window.onDidOpenTerminal(async (terminal: vscode.Terminal) => {
                    // Double check if environment is still active
                    if (!this._context.workspaceState.get(EnvironmentManager.envStateKey)) return;

                    // Avoid injecting into our own temporary install terminals
                    if (terminal.name.startsWith("Pixi Install") || terminal.name.startsWith("Pixi Pack")) return;

                    // We rely on the fact that if environmentVariableCollection is set, the terminal SHOULD have the vars.
                    // But we can't check terminal vars easily.
                    // Flattened command to avoid multiline paste issues
                    const updatePromptCmd = `if (Test-Path Env:\\PIXI_PROMPT) { if (-not (Test-Path Function:\\Global:Prompt_Backup)) { $Global:Prompt_Backup = $function:prompt }; function Global:prompt { Write-Host -NoNewline "$($env:PIXI_PROMPT) "; & $Global:Prompt_Backup } }`;

                    // Delay to ensure the terminal shell and VS Code shell integration have fully loaded
                    setTimeout(() => {
                        terminal.sendText(`${updatePromptCmd}; Clear-Host`);
                    }, 1000);
                });
            }

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

            const command = `"${pixiPath}" install --color always${envName ? ` -e ${envName}` : ''}`;

            const task = new vscode.Task(
                taskDefinition,
                vscode.workspace.getWorkspaceFolder(workspaceUri) || vscode.TaskScope.Workspace,
                `Install${envName ? ` (${envName})` : ''}`,
                'pixi',
                new vscode.ShellExecution(command),
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
            // "pixi exec pixi-pack --environment <env name> --platform <platform> pixi.toml --create-executable"
            // Note: `pixi-pack` needs to be run via `pixi exec` if it was installed in the environment.
            // `pixi exec` runs in the *default* environment context by default, or we might need `-e default` if we added it there.
            // Usually `pixi add` adds to `default` feature/env.

            const terminal = vscode.window.createTerminal({
                name: "Pixi Pack",
                shellPath: process.platform === 'win32' ? 'powershell.exe' : undefined
            });
            terminal.show();
            // We use `pixi exec` which picks up the binary from the env
            let cmd = process.platform === 'win32' ? '& ' : '';
            cmd += `"${pixiPath}" exec pixi-pack --environment ${selectedEnv} --platform ${selectedPlatform} pixi.toml --create-executable`;
            terminal.sendText(cmd);

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
                await fs.promises.rm(pixiDir, { recursive: true, force: true });
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
if not "%~1"=="" (
    set "_TARGET_ENV=%~1"
    goto :activate
)

REM Auto-select logic
set _COUNT=0
set _LAST_ENV=

for /f "tokens=2" %%i in ('"%CD%\\.pixi\\bin\\pixi" info ^| findstr "Environment:"') do (
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
for /f "tokens=2" %%i in ('"%CD%\\.pixi\\bin\\pixi" info ^| findstr "Environment:"') do (
     if not "%%i"=="default" echo %%i
)
exit /b 1

:activate
set "PATH=%CD%\\.pixi\\bin;%PATH%"
if not "%_TARGET_ENV%"=="" (
    for /f "tokens=*" %%i in ('pixi shell-hook --shell cmd -e "%_TARGET_ENV%"') do %%i
) else (
    for /f "tokens=*" %%i in ('pixi shell-hook --shell cmd') do %%i
)
set _TARGET_ENV=
set _COUNT=
set _LAST_ENV=
`;
            try {
                await fs.promises.writeFile(batPath, batContent);
                this.log(`Created ${batPath}`);
            } catch (e) {
                console.error(`Failed to create activate.bat: ${e}`);
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
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Unpacking offline environment to ${targetEnvDir}...`,
                cancellable: false
            }, async () => {
                const platform = process.platform;
                let cmd = '';

                // User requested: script.sh --env-name <name> --output-directory <envs_dir>
                // We use absolute paths for arguments.

                if (platform === 'win32') {
                    if (scriptPath.endsWith('.ps1')) {
                        cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "& '${scriptPath}' --env-name '${envName}' --output-directory '${envsDir}'"`;
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

                // Run from workspace root to allow relative paths if needed, 
                // though we provided absolute output dir.
                await this._exec(cmd, { cwd: workspaceRoot });
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

        try {
            const savedEnv = this._context.workspaceState.get<string>(EnvironmentManager.envStateKey);
            const defaultEnv = config.get<string>('environment', 'default');
            const currentEnv = savedEnv || defaultEnv;

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
                    await this.activateOfflineEnvironment(envDir, offlineName, silent);
                    return;
                }
                // If offline configured but not found, warn? Or fall through?
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
                            await this.activateOfflineEnvironment(envDir, offlineName, silent);
                        }
                        return;
                    }
                } else {
                    // Auto-activate offline if silent request?
                    // Probably yes, if it's the only hope.
                    await this._context.workspaceState.update(EnvironmentManager.envStateKey, offlineName);
                    if (workspaceRoot) {
                        const envDir = path.join(workspaceRoot, '.pixi', 'envs', offlineName);
                        await this.activateOfflineEnvironment(envDir, offlineName, silent);
                    }
                    return;
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
            if (envs.length > 1) {
                // Filter "default" logic if silent
                selectedEnv = envs[0];
                if (selectedEnv === 'default') selectedEnv = envs[1];
            } else if (envs.length === 1) {
                selectedEnv = envs[0];
            }
        }

        if (selectedEnv) {
            await this._context.workspaceState.update(EnvironmentManager.envStateKey, selectedEnv);

            // If offline selected, trigger offline logic explicitly
            if (selectedEnv === offlineName) {
                if (workspaceRoot) {
                    const envDir = path.join(workspaceRoot, '.pixi', 'envs', offlineName);
                    await this.activateOfflineEnvironment(envDir, offlineName, silent);
                }
                return;
            }
        }

        await this.doActivate(selectedEnv, silent);
    }

    // ... (rest of methods)

    private async activateOfflineEnvironment(envDir: string, envName: string, silent: boolean = false) {
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
            vscode.window.showErrorMessage(`No activation script (activate.sh/bat/ps1) found in ${envDir} or ${envDir}/env.`);
            return;
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
                console.log(`Offline environment '${envName}' activated silently.`);
            }
            vscode.commands.executeCommand('setContext', 'pixi.isEnvironmentActive', true);

        } catch (e: any) {
            if (!silent) {
                vscode.window.showErrorMessage(`Failed to activate offline environment: ${e.message}`);
            }
            this.log(`Offline activation error: ${e.message}`);
        }
    }


}

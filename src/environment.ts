import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PixiManager } from './pixi';

export class EnvironmentManager {
    private _pixiManager: PixiManager;
    private _context: vscode.ExtensionContext;
    private _exec: (command: string, options?: any) => Promise<{ stdout: string, stderr: string }>;
    private _outputChannel: vscode.OutputChannel | undefined;
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
                vscode.window.showInformationMessage("pixi.toml already exists. Running install...");
                const pixi = this._pixiManager.getPixiPath();
                const term = vscode.window.createTerminal("Pixi Install", process.env.SHELL, []);
                term.show();
                term.sendText(`"${pixi}" install`);
            } else {
                await this._pixiManager.initProject();
                vscode.window.showInformationMessage("Pixi project initialized.");
            }

            // Auto-activate after creation/install
            await this.activate();

            // Generate helper scripts
            await this.generateActivationScripts(this.getWorkspaceFolderURI()!);


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
            const cmd = `"${pixiPath}" shell-hook --shell bash${envName ? ` -e ${envName}` : ''}`;

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

            // Parse exports
            const lines = stdout.split('\n');
            const envUpdates = new Map<string, string>();

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

                    envUpdates.set(key, value);
                }
            }

            // Apply to VSCode environment (terminals)
            const collection = this._context.environmentVariableCollection;

            for (const [key, value] of envUpdates) {
                let finalValue = value;
                if (key === 'PATH' && pixiPath) {
                    // Ensure the local pixi binary is in the path
                    const pixiBinDir = path.dirname(pixiPath);
                    // Check if already in path (simple check)
                    if (!value.includes(pixiBinDir)) {
                        finalValue = `${pixiBinDir}${path.delimiter}${value}`;
                    }
                }

                this._context.environmentVariableCollection.replace(key, finalValue);
                process.env[key] = finalValue;
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
            const terminal = vscode.window.createTerminal({
                name: `Pixi Install${envName ? ` (${envName})` : ''}`,
                cwd: workspaceUri.fsPath,
                env: process.env // Inherit env
            });

            terminal.show();

            const platform = process.platform;
            let cmd = `"${pixiPath}" install --color always${envName ? ` -e ${envName}` : ''}`;

            // Append exit command so terminal closes automatically on success
            if (platform === 'win32') {
                // Powershell or cmd? VS Code defaults depend on user settings.
                // Safest to just assume user shell logic or try generic chaining.
                // actually, vscode terminals don't auto-close unless the shell process exits.
                // But we don't know the shell. 
                // However, we CAN listen for the process exit if we send the exit command.

                // Let's rely on standard shell delimiters.
                cmd += ` ; exit`;
            } else {
                cmd += ` ; exit $?`;
            }

            terminal.sendText(cmd);

            const disposable = vscode.window.onDidCloseTerminal((t) => {
                if (t === terminal) {
                    disposable.dispose();
                    if (t.exitStatus && t.exitStatus.code === 0) {
                        resolve();
                    } else {
                        // If code is undefined, it might have been closed by user manually
                        const code = t.exitStatus ? t.exitStatus.code : 'unknown';
                        reject(new Error(`Pixi install terminal closed with code ${code}`));
                    }
                }
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

    public async selectOfflineEnvironment() {
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

        // Ensure target directory exists (and is empty? install implies clean slate)
        if (fs.existsSync(targetEnvDir)) {
            // Backup or Clean?
            // Let's clean to ensure fresh install
            try {
                fs.rmSync(targetEnvDir, { recursive: true, force: true });
            } catch (e) {
                console.warn("Failed to clean target dir", e);
            }
        }
        fs.mkdirSync(targetEnvDir, { recursive: true });

        // 3. Execute Script to Unpack
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Unpacking offline environment to ${targetEnvDir}...`,
                cancellable: false
            }, async () => {
                const platform = process.platform;
                let cmd = '';

                // We run the script inside the targetEnvDir.
                // If the script extracts to ., files appear there.
                // If it extracts to env/, files appear in targetEnvDir/env.

                if (platform === 'win32') {
                    if (scriptPath.endsWith('.ps1')) {
                        cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "& '${scriptPath}'"`;
                    } else {
                        // .bat?
                        cmd = `cmd /c "call "${scriptPath}""`;
                    }
                } else {
                    cmd = `bash "${scriptPath}"`;
                }

                // Run in targetEnvDir
                await this._exec(cmd, { cwd: targetEnvDir });
            });

            // Post-unpacking cleanup: Flatten 'env' subdirectory if it exists
            const nestedEnv = path.join(targetEnvDir, 'env');
            if (fs.existsSync(nestedEnv)) {
                // Move all contents from nestedEnv to targetEnvDir
                const files = fs.readdirSync(nestedEnv);
                for (const file of files) {
                    const srcPath = path.join(nestedEnv, file);
                    const destPath = path.join(targetEnvDir, file);
                    fs.renameSync(srcPath, destPath);
                }
                // Remove now empty 'env' dir
                fs.rmdirSync(nestedEnv);
            }

            vscode.window.showInformationMessage(`Offline environment unpacked to ${targetEnvDir}`);

            // 4. Activate Automatically (No prompt)
            await config.update('environment', envName, vscode.ConfigurationTarget.Workspace);
            await this._context.workspaceState.update(EnvironmentManager.envStateKey, envName);
            await this.activate();

        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to unpack/install offline environment: ${e.message}`);
        }
    }

    public async activate(silent: boolean = false) {
        try {
            // Check for Offline Mode
            const config = vscode.workspace.getConfiguration('pixi');
            const offlineName = config.get<string>('offlineEnvironmentName', 'env');
            const savedEnv = this._context.workspaceState.get<string>(EnvironmentManager.envStateKey);
            const defaultEnv = config.get<string>('environment', 'default');
            const currentEnv = savedEnv || defaultEnv;

            const workspaceRoot = this.getWorkspaceFolderURI()?.fsPath;

            this.log(`[Activate] Start. Silent=${silent}`);
            this.log(`[Activate] Config.OfflineName='${offlineName}'`);
            this.log(`[Activate] SavedEnv='${savedEnv}', DefaultEnv='${defaultEnv}' -> CurrentEnv='${currentEnv}'`);
            this.log(`[Activate] WorkspaceRoot='${workspaceRoot}'`);

            // --- CACHE OPTIMIZATION START ---
            // If we are about to activate the offline environment, try to load from cache synchronously first
            if (currentEnv === offlineName) {
                this.log(`[Activate] CurrentEnv matches OfflineName. Checking cache...`);
                const cached = this._context.workspaceState.get<any>(EnvironmentManager.cachedEnvKey);
                if (cached) {
                    this.log(`[Activate] Cache found for '${cached.envName}'. Timestamp=${cached.timestamp}`);
                    if (cached.envName === offlineName && cached.envVars) {
                        this.log(`[Activate] Cache match! Applying ${Object.keys(cached.envVars).length} variables.`);
                        for (const key in cached.envVars) {
                            const value = cached.envVars[key];
                            process.env[key] = value;
                            this._context.environmentVariableCollection.replace(key, value);
                        }
                        this.log(`[Activate] Cache application complete.`);
                    } else {
                        this.log(`[Activate] Cache mismatch or empty vars. CachedName='${cached.envName}'`);
                    }
                } else {
                    this.log(`[Activate] No cache found.`);
                }
            } else {
                this.log(`[Activate] CurrentEnv does not match OfflineName. Skipping cache.`);
            }
            // --- CACHE OPTIMIZATION END ---

            if (currentEnv === offlineName && workspaceRoot) {
                const envDir = path.join(workspaceRoot, '.pixi', 'envs', offlineName);
                this.log(`Checking offline env at: ${envDir}`);
                if (fs.existsSync(envDir)) {
                    this.log(`Offline env found. Activating...`);
                    await this.activateOfflineEnvironment(envDir, offlineName, silent);
                    return;
                }
                this.log(`Offline env directory not found.`);
                if (!silent) {
                    vscode.window.showWarningMessage(`Offline environment '${offlineName}' not found at ${envDir}. Using standard activation.`);
                }
            }

            const installed = await this._pixiManager.isPixiInstalled();
            if (!installed) {
                this.log(`Pixi executable not found.`);
                // If offline mode failed and Pixi is missing, we are dead in the water.
                if (!silent) {
                    vscode.window.showErrorMessage("Pixi not installed and offline environment not found.");
                }
                return;
            }

            const envs = await this.getEnvironments();
            let selectedEnv = '';

            if (envs.length > 1) {
                if (!silent) {
                    const pick = await vscode.window.showQuickPick(envs, {
                        placeHolder: 'Select Pixi Environment to Activate'
                    });
                    if (!pick) { return; }
                    selectedEnv = pick;
                } else {
                    // Filter "default" logic
                    selectedEnv = envs[0];
                    if (selectedEnv === 'default' && envs.length > 1) selectedEnv = envs[1]; // Prefer named env if default is present?
                }
            } else if (envs.length === 1) {
                selectedEnv = envs[0];
            } else if (envs.length === 0) {
                // If no environments are found (e.g., only 'default' existed and was filtered out)
                // We might want to handle this case, perhaps by falling back to 'default' if it's the only one.
                // However, the current instruction is to filter it out.
                // For now, if no non-default envs, we can't activate anything specific.
                // The `doActivate` will then be called with an empty string, which defaults to 'default'.
                // This implicitly means if only 'default' exists, it will be activated.
                // Let's keep `selectedEnv` as empty string if no non-default envs are found.
            }


            if (selectedEnv) {
                await this._context.workspaceState.update(EnvironmentManager.envStateKey, selectedEnv);
            }

            await this.doActivate(selectedEnv, silent);

        } catch (e: any) {
            this.log(`[Activate] FATAL ERROR: ${e.message}`);
            console.error(e);
            if (!silent) vscode.window.showErrorMessage(`Pixi Activation Error: ${e.message}`);
        }
    }

    // ... (rest of methods)

    private async activateOfflineEnvironment(envDir: string, envName: string, silent: boolean = false) {
        // Find activation script in provided dir OR in env/ subdir
        let scriptPath = '';

        const candidates = [envDir, path.join(envDir, 'env')];

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
                    // Exclude irrelevant vars that might change naturally
                    if (key === '_' || key === 'SHLVL' || key === 'PWD' || key === 'OLDPWD') continue;
                    envUpdates.set(key, value);
                }
            }

            this.log(`Applying ${envUpdates.size} environment updates from offline script.`);

            // Convert Map to Obj for caching
            const envObj: { [key: string]: string } = {};

            // 1. Apply Updates from Script (with Path Correction)
            // The script might report paths like `.../env/env` if it expects a nested structure we flattened.
            // We verify if `CONDA_PREFIX` looks deeper than `envDir`.

            let detectedWrongPrefix = '';
            for (const [key, value] of envUpdates) {
                if (key === 'CONDA_PREFIX' && value.startsWith(envDir) && value.length > envDir.length) {
                    // Check if this path actually exists?
                    // If it doesn't, it's definitely wrong.
                    if (!fs.existsSync(value) && fs.existsSync(envDir)) {
                        detectedWrongPrefix = value;
                        this.log(`Detected incorrect CONDA_PREFIX '${detectedWrongPrefix}' (expected '${envDir}'). Fixing paths...`);
                    }
                }
            }

            for (const [key, value] of envUpdates) {
                let fixedValue = value;
                if (detectedWrongPrefix) {
                    // Replace the wrong prefix with the correct one globally
                    // e.g. .../env/env/bin -> .../env/bin
                    fixedValue = fixedValue.split(detectedWrongPrefix).join(envDir);
                }

                // Extra safety: Explicitly force CONDA_PREFIX if it's the key
                if (key === 'CONDA_PREFIX') fixedValue = envDir;

                this.log(`UPDATE: ${key} = ${fixedValue}`);
                this._context.environmentVariableCollection.replace(key, fixedValue);
                process.env[key] = fixedValue;
                envObj[key] = fixedValue;
            }

            // 2. Inject Missing Metadata (Parity with 'pixi shell-hook')
            const workspaceRoot = this.getWorkspaceFolderURI()?.fsPath;
            if (workspaceRoot) {
                const extras = {
                    'PIXI_PROJECT_ROOT': workspaceRoot,
                    'PIXI_PROJECT_MANIFEST': path.join(workspaceRoot, 'pixi.toml'),
                    'PIXI_ENVIRONMENT_NAME': envName,
                    'PIXI_IN_SHELL': '1',
                    'CONDA_PREFIX': envDir
                };

                for (const [key, value] of Object.entries(extras)) {
                    // Only set if not already set (or if we want to enforce override)
                    // We already forced CONDA_PREFIX above, so envObj has it.
                    if (!envObj[key]) {
                        this.log(`INJECT: ${key} = ${value}`);
                        this._context.environmentVariableCollection.replace(key, value);
                        process.env[key] = value;
                        envObj[key] = value;
                    }
                }
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

        } catch (e: any) {
            if (!silent) {
                vscode.window.showErrorMessage(`Failed to activate offline environment: ${e.message}`);
            }
            this.log(`Offline activation error: ${e.message}`);
        }
    }

    public debugState() {
        this.log('--- DEBUG STATE ---');
        this.log(`PROCESS.ENV.PATH: ${process.env.PATH}`);
        this.log(`PROCESS.ENV.CONDA_PREFIX: ${process.env.CONDA_PREFIX}`);
        this.log(`PROCESS.ENV.PIXI_PROJECT_MANIFEST: ${process.env.PIXI_PROJECT_MANIFEST}`);

        const config = vscode.workspace.getConfiguration('pixi');
        const offlineName = config.get<string>('offlineEnvironmentName', 'env');
        const currentEnv = this._context.workspaceState.get<string>(EnvironmentManager.envStateKey);
        this.log(`Config.OfflineName: ${offlineName}`);
        this.log(`WorkspaceState.CurrentEnv: ${currentEnv}`);

        const cached = this._context.workspaceState.get<any>(EnvironmentManager.cachedEnvKey);
        if (cached) {
            this.log(`Cached Env Name: ${cached.envName}`);
            this.log(`Cached Timestamp: ${cached.timestamp}`);
            try {
                this.log(`Cached Vars Keys: ${Object.keys(cached.envVars).join(', ')}`);
            } catch (e) { this.log('Error reading cached vars keys'); }
        } else {
            this.log('No Cache Found.');
        }
        this.log('--- END DEBUG STATE ---');
        vscode.window.showInformationMessage("Pixi Debug State logged to Output.");
    }
}

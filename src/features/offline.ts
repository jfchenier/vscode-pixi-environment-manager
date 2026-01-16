import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IPixiEnvironmentManager } from '../interfaces';

export class OfflineManager {
    // Helper accessors
    // Link back to environment manager via interface

    constructor(private envManager: IPixiEnvironmentManager) { }

    public async generateOfflineEnvironment() {
        if (!this.envManager.getWorkspaceFolderURI()) {
            vscode.window.showErrorMessage('No workspace open.');
            return;
        }

        const workspaceRoot = this.envManager.getWorkspaceFolderURI()!.fsPath;
        const pixiManager = this.envManager.getPixiManager();
        const pixiPath = pixiManager.getPixiPath();

        if (!pixiPath) {
            vscode.window.showErrorMessage('Pixi executable not found.');
            return;
        }

        try {
            // 1. Install pixi-pack in default environment
            this.envManager.log('Ensuring pixi-pack is installed in default environment...');
            await this.envManager.runInstallInTerminal(pixiPath, this.envManager.getWorkspaceFolderURI()!, undefined); // Ensure env is built by adding pixi-pack

            // To be safe and show progress:
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Installing pixi-pack...",
                cancellable: false
            }, async () => {
                // Assume exec can be run directly. Ideally EnvironmentManager handles 'isUpdating' flag if concurrent.
                await this.envManager.exec(`"${pixiPath}" add pixi-pack`, { cwd: workspaceRoot });
            });


            // 2. Select Environment
            const envs = await this.envManager.getEnvironments();
            if (envs.length === 0) {
                vscode.window.showErrorMessage('No environments found to pack.');
                return;
            }

            const selectedEnv = await vscode.window.showQuickPick(envs, {
                placeHolder: 'Select Environment to Pack'
            });

            if (!selectedEnv) { return; }

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

            if (!selectedPlatform) { return; }

            // 4. Execute Generation Command
            // Use vscode.Task for consistent terminal behavior
            const cmd = `"${pixiPath}" exec pixi-pack --environment ${selectedEnv} --platform ${selectedPlatform} pixi.toml --create-executable`;

            // Explicitly specify the shell executable to avoid using the user's "Default Profile".
            // Duplicate getSafeShellExecutionOptions logic or expose it?
            // Duplication is safer than too much public surface for now.
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

    public async loadOfflineEnvironment() {
        if (!this.envManager.getWorkspaceFolderURI()) {
            vscode.window.showErrorMessage('No workspace open.');
            return;
        }

        const workspaceRoot = this.envManager.getWorkspaceFolderURI()!.fsPath;

        // 1. Select File
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'Environment Scripts': ['sh', 'bat', 'ps1']
            },
            title: 'Select Offline Environment Installer'
        });

        if (!uris || uris.length === 0) { return; }
        const scriptPath = uris[0].fsPath;

        // 2. Prompt for Name
        const config = vscode.workspace.getConfiguration('pixi');
        const defaultName = config.get<string>('offlineEnvironmentName', 'env');

        const envName = await vscode.window.showInputBox({
            placeHolder: 'Enter a name for the offline environment',
            value: defaultName
        });

        if (!envName) { return; }

        const envsDir = path.join(workspaceRoot, '.pixi', 'envs');
        const targetEnvDir = path.join(envsDir, envName);

        if (fs.existsSync(targetEnvDir)) {
            const overwrite = await vscode.window.showWarningMessage(
                `Environment '${envName}' already exists. Overwrite?`,
                "Yes", "No"
            );
            if (overwrite !== "Yes") { return; }
            await fs.promises.rm(targetEnvDir, { recursive: true, force: true });
        }

        // 3. Execute Script to Unpack
        try {
            const platform = process.platform;
            let cmd = '';

            // User requested: script.sh --env-name <name> --output-directory <envs_dir>
            // Use absolute paths for arguments.

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

            // Save the environment name to settings so activate() logic can find it
            await config.update('offlineEnvironmentName', envName, vscode.ConfigurationTarget.Workspace);

            // Update state. Use string literal 'pixiSelectedEnvironment' to avoid circular reference.
            await this.envManager.getContext().workspaceState.update('pixiSelectedEnvironment', envName);
            await this.envManager.activate(true);

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

    public async activateOfflineEnvironment(envDir: string, envName: string, silent: boolean = false): Promise<boolean> {
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

        this.envManager.log(`Activating offline environment '${envName}' using ${scriptPath}`);

        try {
            // Fix cwd to be the script's directory, ensuring relative paths in script work
            const scriptDir = path.dirname(scriptPath);

            // Sanitize environment for the Diff determination
            const runEnv = { ...process.env };
            // cachedEnvKey = 'pixi.cachedEnv'
            const cached = this.envManager.getContext().workspaceState.get<any>('pixi.cachedEnv');

            if (cached && cached.envName === envName && cached.envVars) {
                this.envManager.log('Sanitizing environment for diff calculation (removing cached vars from baseline).');
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

            const { stdout } = await this.envManager.exec(cmd, { cwd: scriptDir, env: runEnv });

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
                        if (key) { map.set(key, value); }
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
                    if (key === '_' || key === 'SHLVL' || key === 'PWD' || key === 'OLDPWD' || key === 'TERM' || key === 'TERMINFO' || key === 'TERMINFO_DIRS') { continue; }
                    envUpdates.set(key, value);
                }
            }

            this.envManager.log(`Applying ${envUpdates.size} environment updates from offline script.`);

            // Convert Map to Obj for caching
            const envObj: { [key: string]: string } = {};

            // 1. Apply Updates from Script
            // Generic Sanitization for offline environment too
            const conflicts = ['VIRTUAL_ENV', 'PYTHONPATH', 'CONDA_DEFAULT_ENV', 'CONDA_PYTHON_EXE', 'CONDA_PROMPT_MODIFIER'];
            for (const conflict of conflicts) {
                if (!envUpdates.has(conflict)) {
                    this.envManager.getContext().environmentVariableCollection.replace(conflict, '');
                }
            }

            for (const [key, value] of envUpdates) {
                this.envManager.log(`UPDATE: ${key} = ${value}`);
                this.envManager.getContext().environmentVariableCollection.replace(key, value);
                process.env[key] = value;
                envObj[key] = value;
            }



            // Save to Cache
            this.envManager.log(`Caching environment '${envName}'`);
            await this.envManager.getContext().workspaceState.update('pixi.cachedEnv', {
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
            this.envManager.updateStatusBar(envName || 'default');

        } catch (e: any) {
            this.envManager.updateStatusBar(envName);
            if (!silent) {
                vscode.window.showErrorMessage(`Failed to activate offline environment: ${e.message}`);
            }
            this.envManager.log(`Offline activation error: ${e.message}`);
        }
        return true;
    }

    public async clearEnvironment() {
        if (!this.envManager.getWorkspaceFolderURI()) {
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
            await this.envManager.deactivate(true); // Silent deactivate

            // 2. Delete .pixi directory
            const workspacePath = this.envManager.getWorkspaceFolderURI()!.fsPath;
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

    private async getProjectPlatforms(workspaceRoot: string): Promise<string[]> {
        try {
            const tomlPath = path.join(workspaceRoot, 'pixi.toml');
            if (fs.existsSync(tomlPath)) {
                const content = await fs.promises.readFile(tomlPath, 'utf8');
                // Simple regex to find platforms = ["..."] or platforms = [...]
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

    private getSafeShellExecutionOptions(cwd: string): vscode.ShellExecutionOptions {
        // Explicitly specify shell to bypass user's default profile arguments that might be interactive.
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

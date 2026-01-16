import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function downloadFile(url: string, dest: string, retries: number = 3): Promise<void> {

    const pkg = url.startsWith('https') ? https : http;

    return new Promise((resolve, reject) => {
        const attempt = (remaining: number) => {
            const request = pkg.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    if (!response.headers.location) {
                        reject(new Error('Redirect with no location header'));
                        return;
                    }
                    downloadFile(response.headers.location, dest, retries).then(resolve).catch(reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    if (remaining > 0 && (response.statusCode === 504 || response.statusCode === 503 || response.statusCode === 502 || response.statusCode === 500)) {
                        console.warn(`Download failed with ${response.statusCode}, retrying... (${remaining} left)`);
                        setTimeout(() => attempt(remaining - 1), 1000);
                        return;
                    }
                    reject(new Error(`Failed to download: ${response.statusCode}`));
                    return;
                }

                const file = fs.createWriteStream(dest);
                response.pipe(file);

                file.on('finish', () => {
                    file.close();
                    resolve();
                });

                file.on('error', (err) => {
                    fs.unlink(dest, () => { });
                    reject(err);
                });
            });

            request.on('error', (err) => {
                if (remaining > 0) {
                    console.warn(`Request failed with ${err.message}, retrying... (${remaining} left)`);
                    setTimeout(() => attempt(remaining - 1), 1000);
                    return;
                }
                reject(err);
            });
        };
        attempt(retries);
    });
}

export class PixiManager {
    private _workspaceUri: vscode.Uri | undefined;
    private _pixiName: string;
    private _outputChannel: vscode.OutputChannel | undefined;
    private _systemCheckPromise: Promise<void> | undefined;

    constructor(outputChannel?: vscode.OutputChannel) {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this._workspaceUri = vscode.workspace.workspaceFolders[0].uri;
        }
        this._pixiName = process.platform === 'win32' ? 'pixi.exe' : 'pixi';
        this._outputChannel = outputChannel;
    }

    private log(message: string) {
        if (this._outputChannel) {
            this._outputChannel.appendLine(`[PixiManager] ${message}`);
        }
    }

    public getPixiPath(): string | undefined {
        const config = vscode.workspace.getConfiguration('pixi');
        const useSystem = config.get<boolean>('useSystemPixi', false);

        if (useSystem) {
            // Return 'pixi' to rely on system PATH, or resolve it?
            // "pixi" is simpler but might fail if PATH isn't propagated to VSCode perfectly.
            // But 'pixi' usually works in terminal.
            // However, child_process.exec might need full path?
            // Let's assume 'pixi' works if in path.
            // Or better: try to find it?
            // For now, let's return 'pixi'.
            return this._pixiName; // 'pixi' or 'pixi.exe'
        }

        if (!this._workspaceUri) {
            return undefined;
        }
        return path.join(this._workspaceUri.fsPath, '.pixi', 'bin', this._pixiName);
    }

    public async isPixiInstalled(): Promise<boolean> {
        const pixiPath = this.getPixiPath();
        if (!pixiPath) {
            return false;
        }

        // If system, check simple execution
        if (pixiPath === this._pixiName) {
            try {
                // Check if 'pixi --version' works
                await execAsync(`"${pixiPath}" --version`);
                return true;
            } catch {
                return false;
            }
        }

        try {
            await fs.promises.access(pixiPath, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }

    public async checkAndPromptSystemPixi(context: vscode.ExtensionContext): Promise<void> {
        if (this._systemCheckPromise) {
            return this._systemCheckPromise;
        }

        this._systemCheckPromise = (async () => {
            const config = vscode.workspace.getConfiguration('pixi');
            const useSystem = config.get<boolean>('useSystemPixi', false);

            if (useSystem) {
                // Already using system, nothing to do
                return;
            }

            // Check if ignored
            const ignoreKey = 'pixi.ignoreSystemPixi';
            if (context.globalState.get<boolean>(ignoreKey)) {
                return;
            }

            // Check if system pixi exists
            // We use a separate check here because getPixiPath points to local by default
            const systemName = this._pixiName;
            try {
                await execAsync(`"${systemName}" --version`);

                // It exists! Prompt user.
                const selection = await vscode.window.showInformationMessage(
                    "A system installation of Pixi was detected. Would you like to use it instead of the bundled executable?",
                    "Yes",
                    "No (Use Bundled Executable)",
                    "Later"
                );

                if (selection === "Yes") {
                    await config.update('useSystemPixi', true, vscode.ConfigurationTarget.Global);

                    const autoReload = config.get<boolean>('autoReload');
                    if (autoReload) {
                        vscode.window.showInformationMessage("Switched to System Pixi. Reloading window...");
                        vscode.commands.executeCommand("workbench.action.reloadWindow");
                    } else {
                        const reloadSelection = await vscode.window.showInformationMessage(
                            "Switched to System Pixi. Reload window to apply changes?",
                            "Reload"
                        );
                        if (reloadSelection === "Reload") {
                            vscode.commands.executeCommand("workbench.action.reloadWindow");
                        }
                    }
                } else if (selection === "No (Use Bundled Executable)") {
                    await context.globalState.update(ignoreKey, true);
                }
                // Later: Do nothing
            } catch {
                // System pixi not found
                return;
            }
        })();

        return this._systemCheckPromise;
    }

    public async ensurePixi(): Promise<void> {
        const installed = await this.isPixiInstalled();
        if (!installed) {
            await this.installPixi();
        }
    }

    public async installPixi(): Promise<void> {
        if (this._systemCheckPromise) {
            await this._systemCheckPromise;
        }

        // Check if we are supposed to be using system pixi
        const config = vscode.workspace.getConfiguration('pixi');
        if (config.get<boolean>('useSystemPixi')) {
            const selection = await vscode.window.showErrorMessage(
                "System Pixi executable not found. Would you like to disable the 'Use System Pixi' setting and install Pixi locally?",
                "Disable & Install Locally",
                "Cancel"
            );

            if (selection === "Disable & Install Locally") {
                await config.update('useSystemPixi', false, vscode.ConfigurationTarget.Global);
                // Proceed with local installation
            } else {
                throw new Error("System Pixi not found and local installation cancelled.");
            }
        }

        if (!this._workspaceUri) {
            throw new Error('No workspace folder open.');
        }

        const platform = process.platform;
        const arch = os.arch();

        this.log(`Installing Pixi for platform: ${platform}, arch: ${arch}`);

        // Correct URLs check
        // User used: https://github.com/prefix-dev/pixi/releases/latest/download/pixi-x86_64-unknown-linux-musl.tar.gz
        // This seems correct for Linux.

        let downloadUrl = '';
        if (platform === 'linux' && arch === 'x64') {
            downloadUrl = 'https://github.com/prefix-dev/pixi/releases/latest/download/pixi-x86_64-unknown-linux-musl.tar.gz';
        } else if (platform === 'darwin' && arch === 'arm64') {
            downloadUrl = 'https://github.com/prefix-dev/pixi/releases/latest/download/pixi-aarch64-apple-darwin.tar.gz';
        } else if (platform === 'darwin' && arch === 'x64') {
            downloadUrl = 'https://github.com/prefix-dev/pixi/releases/latest/download/pixi-x86_64-apple-darwin.tar.gz';
        } else if (platform === 'win32' && arch === 'x64') {
            downloadUrl = 'https://github.com/prefix-dev/pixi/releases/latest/download/pixi-x86_64-pc-windows-msvc.zip';
        } else {
            throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
        }

        this.log(`Download URL: ${downloadUrl}`);

        const installDir = path.join(this._workspaceUri.fsPath, '.pixi', 'bin');
        await fs.promises.mkdir(installDir, { recursive: true });

        const archiveName = platform === 'win32' ? 'pixi_archive.zip' : 'pixi_archive.tar.gz';
        const destFile = path.join(installDir, archiveName);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Installing Pixi...",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Downloading..." });
            await downloadFile(downloadUrl, destFile);

            progress.report({ message: "Extracting..." });

            // Validate file before extracting?
            // Simple size check?
            const stats = await fs.promises.stat(destFile);
            if (stats.size < 1000) {
                throw new Error(`Downloaded file is too small (${stats.size} bytes). Likely failed.`);
            }

            this.log(`Extracting to: ${installDir}`);

            if (platform === 'win32') {
                await execAsync(`powershell -command "Expand-Archive -Force '${destFile}' '${installDir}'"`);
            } else {
                await execAsync(`tar -xzf "${destFile}" -C "${installDir}"`);
            }
        });

        await fs.promises.unlink(destFile);

        const finalPixiPath = this.getPixiPath()!;
        this.log(`Installed Pixi at: ${finalPixiPath}`);

        if (platform !== 'win32') {
            await fs.promises.chmod(finalPixiPath, 0o755);
        }
    }

    public async initProject(): Promise<void> {
        const pixi = this.getPixiPath();
        if (!pixi || !this._workspaceUri) { return; }

        this.log(`Executing: "${pixi}" init`);
        await execAsync(`"${pixi}" init`, { cwd: this._workspaceUri.fsPath });

        this.log(`Executing: "${pixi}" install`);
        await execAsync(`"${pixi}" install`, { cwd: this._workspaceUri.fsPath });
    }
    public async checkUpdate(context: vscode.ExtensionContext): Promise<void> {
        const config = vscode.workspace.getConfiguration('pixi');
        if (!config.get<boolean>('checkUpdates', true)) {
            return;
        }

        const pixiPath = this.getPixiPath();
        if (!pixiPath) { return; }

        try {
            // Run dry-run to check for updates
            // Output format: "Pixi version would be updated from X.Y.Z to A.B.C, but --dry-run given."
            const { stderr, stdout } = await execAsync(`"${pixiPath}" self-update --dry-run`);
            // Pixi often writes to stderr for info messages
            const output = stdout + stderr;

            const match = output.match(/updated from .* to (.*),/);
            if (match && match[1]) {
                const newVersion = match[1].trim();

                const selection = await vscode.window.showInformationMessage(
                    `A new version of Pixi (${newVersion}) is available.`,
                    "Update Now",
                    "Later",
                    "Don't Ask Again"
                );

                if (selection === "Update Now") {
                    await this.updatePixi(pixiPath);
                } else if (selection === "Don't Ask Again") {
                    await config.update('checkUpdates', false, vscode.ConfigurationTarget.Global);
                }
            }
        } catch (e: any) {
            // If self-update fails or is not supported, just log and ignore
            this.log(`Update check failed: ${e.message}`);
        }
    }

    private async updatePixi(pixiPath: string): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Updating Pixi...",
            cancellable: false
        }, async () => {
            try {
                await execAsync(`"${pixiPath}" self-update`);
                vscode.window.showInformationMessage("Pixi updated successfully.");
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to update Pixi: ${e.message}`);
            }
        });
    }
}

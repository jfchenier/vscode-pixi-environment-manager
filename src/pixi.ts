import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function downloadFile(url: string, dest: string, retries: number = 3): Promise<void> {
    const uri = new URL(url);
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
        try {
            await fs.promises.access(pixiPath, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }

    public async ensurePixi(): Promise<void> {
        const installed = await this.isPixiInstalled();
        if (!installed) {
            await this.installPixi();
        }
    }

    public async installPixi(): Promise<void> {
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

        const destFile = path.join(installDir, 'pixi_archive');

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
        if (!pixi || !this._workspaceUri) return;

        this.log(`Executing: "${pixi}" init`);
        await execAsync(`"${pixi}" init`, { cwd: this._workspaceUri.fsPath });

        this.log(`Executing: "${pixi}" install`);
        await execAsync(`"${pixi}" install`, { cwd: this._workspaceUri.fsPath });
    }
}

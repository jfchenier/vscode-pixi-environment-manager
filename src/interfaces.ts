import * as vscode from 'vscode';
import { PixiManager } from './pixi';

export interface IPixiEnvironmentManager {
    getWorkspaceFolderURI(): vscode.Uri | undefined;
    getPixiManager(): PixiManager;
    getContext(): vscode.ExtensionContext;
    log(message: string): void;

    // Execute command utility
    exec(command: string, options?: any): Promise<{ stdout: string, stderr: string }>;

    // Core methods needed by features
    activate(silent: boolean, forceEnv?: string): Promise<void>;
    deactivate(silent: boolean): Promise<void>;
    runInstallInTerminal(pixiPath: string, workspaceUri: vscode.Uri, envName?: string): Promise<void>;
    getEnvironments(): Promise<string[]>;

    updateStatusBar(envName?: string): void;
}

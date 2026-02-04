import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EnvironmentManager } from '../../environment';
import { PixiManager } from '../../pixi';

// Mock exec
const mockExec = async (cmd: string, opts: any) => {
    if (cmd.indexOf('info') !== -1) {
        return { stdout: JSON.stringify({ environments_info: [{ name: 'default' }, { name: 'test' }] }), stderr: '' };
    }
    if (cmd.indexOf('shell-hook') !== -1) {
        return { stdout: JSON.stringify({ environment_variables: { FOO: "BAR" } }), stderr: '' };
    }
    return { stdout: '', stderr: '' };
};

suite('Install Task Integration Test Suite', () => {
    let sandboxDir: string;
    let cacheDir: string;

    setup(async () => {
        // Create a separate temp cache dir to force download behavior
        sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixi-vscode-testing-'));
        cacheDir = path.join(sandboxDir, '.cache');
        fs.mkdirSync(cacheDir, { recursive: true });

        // It is difficult to force the Extension Host process to change its env var for the *child* task
        // unless passed in ShellExecution options.
        // So this test validates the logic, but might not prove "Progress Bar" visually.
    });

    teardown(() => {
        try {
            fs.rmSync(sandboxDir, { recursive: true, force: true });
        } catch { }
    });

    test('Activate triggers pixi install terminal', async function () {
        this.timeout(10000);
        const outputChannel = vscode.window.createOutputChannel("Pixi Test");
        const pixiManager = new PixiManager(outputChannel);

        // Mock context
        const mockContext = {
            workspaceState: {
                get: () => undefined,
                update: () => Promise.resolve()
            },
            environmentVariableCollection: {
                replace: () => { },
                clear: () => { }
            },
            subscriptions: []
        } as unknown as vscode.ExtensionContext;

        const envManager = new EnvironmentManager(pixiManager, mockContext, outputChannel, mockExec);

        // Mock window createTerminal
        let terminalCreated = false;

        // Spy on onDidOpenTerminal instead of creating spies on vscode.window.createTerminal

        const terminalDisposable = vscode.window.onDidOpenTerminal(terminal => {
            if (terminal.name.startsWith("Pixi Install")) {
                terminalCreated = true;

                // Since the code AWAITS the terminal closing, simulate closing it!
                // Wait a tick, then close.
                setTimeout(() => {
                    // Cannot easily close it programmatically with fake exit code.
                    // But strictly speaking, if the goal is just to verify it started, successful finish is not required.
                }, 100);
            }
        });


        envManager.getWorkspaceFolderURI = () => vscode.Uri.file(sandboxDir);
        pixiManager.isPixiInstalled = async () => true;
        pixiManager.getPixiPath = () => 'pixi';

        // Race the activate call.

        // Could replace the runInstallInTerminal method on the instance for THIS test?
        // No, need to test that it calls createTerminal.

        // Let's modify the test to just check if createTerminal was called by monkey-patching VS Code? No.

        // Best approach: Allow the test to timeout or mock vscode.window.createTerminal if possible.
        // But difficult to do easily.

        // Close the terminal from the test!

        // Try to run it.

        try {
            // Rely on loop to kill the actual terminal if it appears.
            const checkInterval = setInterval(() => {
                const terms = vscode.window.terminals;
                const pixiTerm = terms.find(t => t.name.includes("Install"));
                if (pixiTerm) {
                    terminalCreated = true;
                    // Cannot set exit code locally.
                    pixiTerm.dispose();
                    clearInterval(checkInterval);
                }
            }, 200);

            // Race against time
            // Ensure install is forced
            (envManager as any).doActivate("test", false, true);

            // Allow some time
            await new Promise(r => setTimeout(r, 5000));

            clearInterval(checkInterval);

        } catch {
        }

        terminalDisposable.dispose();
        assert.strictEqual(terminalCreated, true, 'Install terminal should have been created');
    });


});

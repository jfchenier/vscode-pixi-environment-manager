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

        // We can't easily force the Extension Host process to change its env var for the *child* task 
        // unless we pass it in ShellExecution options.
        // But the current implementation doesn't allow injecting env vars into ShellExecution.
        // So this test validates the logic, but might not prove "Progress Bar" visually 
        // unless we modify the code to support env injection.
        // For now, we will rely on the fact that we can trigger the task.
    });

    teardown(() => {
        try {
            fs.rmSync(sandboxDir, { recursive: true, force: true });
        } catch { }
    });

    test('Activate triggers pixi install terminal', async () => {
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
            }
        } as unknown as vscode.ExtensionContext;

        const envManager = new EnvironmentManager(pixiManager, mockContext, outputChannel, mockExec);

        // Mock window createTerminal
        let terminalCreated = false;

        // We have to spy on vscode.window.createTerminal. 
        // But doing that in this integrated test environment is hard if we can't redefine the import.
        // Instead, let's rely on onDidOpenTerminal.

        const terminalDisposable = vscode.window.onDidOpenTerminal(terminal => {
            if (terminal.name.startsWith("Pixi Install")) {
                terminalCreated = true;

                // Since the code AWAITS the terminal closing, we must simulate closing it!
                // Wait a tick, then close.
                setTimeout(() => {
                    // We can't programmatically close it easily with fake exit code 
                    // unless we mocked the whole object.
                    // But strictly speaking, if we just want to verify it started, we don't need to finish successfuly.
                    // The activate call will hang awaiting close.
                    // We can dispose logic.
                }, 100);
            }
        });


        envManager.getWorkspaceFolderURI = () => vscode.Uri.file(sandboxDir);
        pixiManager.isPixiInstalled = async () => true;
        pixiManager.getPixiPath = () => 'pixi';

        // To avoid hanging forever, we race the activate call or mock the runInstallInTerminal method?
        // Mocking the private method is ugly but possible via prototype or casting.
        // Alternatively, we just check if it CALLED createTerminal.

        // Actually, we can just replace the runInstallInTerminal method on the instance for THIS test?
        // No, we want to test that it calls createTerminal.

        // Let's modify the test to just check if createTerminal was called by monkey-patching VS Code? No.

        // Best approach: We will allow the test to timeout or just mock `vscode.window.createTerminal` if possible.
        // But we can't easily.

        // Wait! We can close the terminal from the test!
        // terminal.dispose() fires onDidCloseTerminal.
        // But we need to set exitStatus.
        // real terminals in extension testing environment are real.

        // We will just try to run it.

        try {
            // We will rely on our own loop to kill the actual terminal if it appears.
            const checkInterval = setInterval(() => {
                const terms = vscode.window.terminals;
                const pixiTerm = terms.find(t => t.name.includes("Install"));
                if (pixiTerm) {
                    terminalCreated = true;
                    // We can't set exit code locally.
                    // So execute won't resolve nicely.
                    // But we asserted output.
                    pixiTerm.dispose();
                    clearInterval(checkInterval);
                }
            }, 200);

            // Race against time
            // Ensure we force install
            (envManager as any).doActivate("test", false, true);

            // Allow some time
            await new Promise(r => setTimeout(r, 1000));

            clearInterval(checkInterval);

        } catch (e) {
        }

        terminalDisposable.dispose();
        assert.strictEqual(terminalCreated, true, 'Install terminal should have been created');
    });


});

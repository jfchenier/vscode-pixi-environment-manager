
import * as assert from 'assert';
import * as vscode from 'vscode';
import { EnvironmentManager } from '../../environment';
import { PixiManager } from '../../pixi';

class MockPixiManager extends PixiManager {
    constructor() {
        super();
    }
    public getPixiPath(): string | undefined {
        return '/mock/pixi';
    }
    public async isPixiInstalled(): Promise<boolean> {
        return true;
    }
}

suite('Space Path Reproduction Test Suite', () => {
    let mockPixiManager: MockPixiManager;
    let envManager: EnvironmentManager;
    let tasks: vscode.Task[] = [];

    // Store original executeTask to restore later
    const originalExecuteTask = vscode.tasks.executeTask;

    setup(() => {
        mockPixiManager = new MockPixiManager();
        // We pass undefined for outputChannel and exec for now, as we only care about runInstallInTerminal logic constructing the task
        const context = {
            subscriptions: [],
            workspaceState: {
                get: () => undefined,
                update: () => Promise.resolve()
            },
            environmentVariableCollection: {
                clear: () => { },
                replace: () => { },
                prepend: () => { }
            }
        } as unknown as vscode.ExtensionContext;

        envManager = new EnvironmentManager(mockPixiManager, context);

        tasks = [];
    });

    teardown(() => {
        (vscode.tasks as any).executeTask = originalExecuteTask;
    });

    test('runInstallInTerminal should not use eval in command line', async () => {
        // Mock a workspace with spaces
        const spacePath = '/path with spaces/project';
        const workspaceUri = vscode.Uri.file(spacePath);

        let lastExecution: vscode.TaskExecution | undefined;

        // Mock vscode.tasks.executeTask
        (vscode.tasks as any).executeTask = async (task: vscode.Task) => {
            tasks.push(task);
            lastExecution = {
                task,
                terminate: () => { }
            } as unknown as vscode.TaskExecution;
            return lastExecution;
        };

        // Mock onDidEndTaskProcess
        (vscode.tasks as any).onDidEndTaskProcess = ((listener: (e: vscode.TaskProcessEndEvent) => any) => {
            // Use setTimeout to allow the promise chain in runInstallInTerminal to settle slightly if needed,
            // though sync call is also likely handled.
            setTimeout(() => {
                if (lastExecution) {
                    listener({ execution: lastExecution, exitCode: 0 });
                }
            }, 10);
            return { dispose: () => { } };
        });

        // We need to force logic that thinks it's NOT windows to trigger the eval path
        await envManager.runInstallInTerminal('/mock/pixi', workspaceUri);

        assert.strictEqual(tasks.length, 1);
        const task = tasks[0];
        const execution = task.execution as vscode.ShellExecution;
        const commandLine = execution.commandLine;

        assert.ok(commandLine, 'Command line should be defined');

        console.log('Command Line Generated:', commandLine);

        // Verification: Command line should be exactly the install command, no 'echo' wrapper
        const expectedCmd = `"/mock/pixi" install`;

        if (process.platform === 'win32') {
            assert.ok(commandLine.startsWith('& '), 'Command line should start with call operator & on Windows');
            // Expect escaped quotes
            // The generated command is: & \"/mock/pixi\" install
            const expectedCmdEscaped = `& \\"/mock/pixi\\" install`;
            assert.ok(commandLine.includes(expectedCmdEscaped), `Command line should match escaped content structure. Actual: ${commandLine}`);
            assert.ok(commandLine.includes('\\"'), 'Command line should contain escaped quotes');
        } else {
            assert.ok(commandLine.includes(expectedCmd), `Command line should contain '${expectedCmd}'`);
            assert.ok(!commandLine.includes('&'), 'Command line should not contain call operator & on non-Windows');
        }

        assert.ok(!commandLine.includes('echo'), 'Command line should not contain "echo" wrapper');
        assert.ok(!commandLine.includes('eval'), 'Command line should not contain "eval"');
    });

    test('Real execution test with spaces in path', async function () {
        const cp = require('child_process');
        const promisify = require('util').promisify;
        const exec = promisify(cp.exec);
        const fs = require('fs');
        const os = require('os');
        const path = require('path');

        // Create a temp dir with spaces
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixi test spaces '));

        try {
            if (process.platform === 'win32') {
                const scriptPath = path.join(tmpDir, 'mock_pixi.bat');
                fs.writeFileSync(scriptPath, '@echo success');

                const pixiPath = scriptPath;
                const envName = 'test-env';

                // The Logic from EnvironmentManager for Windows (escaped quotes)
                const fullCommand = `& \\"${pixiPath}\\" install -e \\"${envName}\\"`;

                // Use full path to Powershell to avoid PATH issues in test environment
                const powershellPath = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

                // Execute it using PowerShell -Command
                const { stdout } = await exec(`"${powershellPath}" -Command "${fullCommand}"`);
                assert.ok(stdout.includes('success'), 'Script should have executed successfully on Windows');

            } else {
                // Linux / Mac
                const scriptPath = path.join(tmpDir, 'mock_pixi.sh');
                // Create executable script
                fs.writeFileSync(scriptPath, '#!/bin/sh\necho success');
                fs.chmodSync(scriptPath, '755');

                const pixiPath = scriptPath;
                const envName = 'test-env';

                // Standard quoting for Unix (no call operator, no extra escaping)
                const fullCommand = `"${pixiPath}" install -e "${envName}"`;

                // Execute using standard shell
                const { stdout } = await exec(fullCommand);
                assert.ok(stdout.includes('success'), 'Script should have executed successfully on Unix');
            }

        } finally {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch { }
        }
    });
});

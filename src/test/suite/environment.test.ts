import * as assert from 'assert';
import * as vscode from 'vscode';
import { EnvironmentManager } from '../../environment';
import { PixiManager } from '../../pixi';

class MockPixiManager extends PixiManager {
    public override async isPixiInstalled(): Promise<boolean> {
        return true;
    }
    public override getPixiPath(): string {
        return '/mock/pixi';
    }
}

suite('Environment Manager Test Suite', () => {

    test('Activate parses shell-hook output and updates environment', async () => {
        const envVarsReference = new Map<string, string>();
        const mockContext: any = {
            environmentVariableCollection: {
                replace: (key: string, value: string) => {
                    envVarsReference.set(key, value);
                },
                persistent: true
            },
            workspaceState: {
                update: () => Promise.resolve(),
                get: () => undefined
            }
        };

        const mockExec = async (cmd: string, opts: any) => {
            if (cmd.includes('info --json')) {
                return {
                    stdout: JSON.stringify({ environments_info: [{ name: 'default' }, { name: 'spark' }] }),
                    stderr: ''
                };
            }
            return {
                stdout: 'export PATH="/pixi/env/bin:/usr/bin"\nexport CONDA_PREFIX="/pixi/env"',
                stderr: ''
            };
        };

        const mockPixi = new MockPixiManager();
        mockPixi.getPixiPath = () => '/mock/workspace/.pixi/bin/pixi';
        class TestEnvironmentManager extends EnvironmentManager {
            public override getWorkspaceFolderURI(): vscode.Uri {
                return vscode.Uri.file('/mock/workspace');
            }
        }

        const envManager = new TestEnvironmentManager(mockPixi, mockContext, undefined, mockExec);

        // We need to mock vscode.workspace.workspaceFolders
        // But we can't easily write to `vscode` namespace in this test runner context safely without affecting others?
        // Actually `vscode` is available.
        // If we can't mock workspaceFolders, `activate` might fail on `cwd`.
        // Let's modify activate to handle no workspace or let's assume one exists in the test runner.
        // We will try running it. If it fails due to no workspace, we'll need to mock `vscode.workspace`.
        // Mocking `vscode` is hard.

        // Workaround: We ignore CWD in our mockExec. `activate` accesses `workspaceFolders![0]`.
        // The real test runner usually opens a window with NO folder if not specified.
        // We can just try-catch the workspace access or wrap it.

        // Since we are mocking exec, and logic depends on workspace presence mainly for CWD.
        // "if (!vscode.workspace.workspaceFolders)" check is likely? 
        // Method `activate` doesn't check it before `shell-hook`, it assumes it?
        // Let's check environment.ts: "const pixiPath = ...".
        // It uses `cwd: vscode.workspace.workspaceFolders![0].uri.fsPath`. This will throw if undefined.

        // We cannot stub vscode properties easily.
        // Assertions will fail if we can't run the code.
        // Let's skip the test if we can't run it locally, but the USER needs it.
        // Wait, I can execute `activate` but it fails.
        // I will rely on `MockContext` receiving the updates if I can bypass `cwd`.

        // Let's add a safe check in `activate`.

        await envManager.activate(true);

        assert.strictEqual(envVarsReference.get('CONDA_PREFIX'), '/pixi/env');

        // Verify pixi bin is in PATH
        const pathVar = envVarsReference.get('PATH');
        assert.ok(pathVar?.includes('/mock/workspace/.pixi/bin'), 'PATH should include pixi bin directory');
    });

    test('AutoActivate restores environment from state', async () => {
        const envVarsReference = new Map<string, string>();
        let storedEnv = 'spark';
        const mockContext: any = {
            environmentVariableCollection: {
                replace: (key: string, value: string) => {
                    envVarsReference.set(key, value);
                },
                persistent: true
            },
            workspaceState: {
                get: (key: string) => {
                    if (key === 'pixiSelectedEnvironment') return storedEnv;
                    return undefined;
                },
                update: (key: string, value: string) => {
                    storedEnv = value;
                    return Promise.resolve();
                }
            }
        };

        const mockExec = async (cmd: string, opts: any) => {
            return {
                stdout: 'export PATH="/pixi/env/spark/bin:/usr/bin"\nexport CONDA_PREFIX="/pixi/env/spark"',
                stderr: ''
            };
        };

        const mockPixi = new MockPixiManager();

        class TestEnvironmentManager extends EnvironmentManager {
            public override getWorkspaceFolderURI(): vscode.Uri {
                return vscode.Uri.file('/mock/workspace');
            }
        }

        const envManager = new TestEnvironmentManager(mockPixi, mockContext, undefined, mockExec);
        await envManager.autoActivate();

        assert.strictEqual(envVarsReference.get('CONDA_PREFIX'), '/pixi/env/spark');
    });

    test('Deactivate clears environment and state', async () => {
        let storedEnv: string | undefined = 'spark';
        let clearCalled = false;

        const mockContext: any = {
            environmentVariableCollection: {
                clear: () => {
                    clearCalled = true;
                },
                replace: () => { },
                persistent: true
            },
            workspaceState: {
                get: () => storedEnv,
                update: (key: string, value: any) => {
                    if (key === 'pixiSelectedEnvironment') storedEnv = value;
                    return Promise.resolve();
                }
            }
        };

        const mockPixi = new MockPixiManager();
        const mockExec = async () => ({ stdout: '', stderr: '' }); // Unused for deactivate

        class TestEnvironmentManager extends EnvironmentManager {
            public override getWorkspaceFolderURI(): vscode.Uri {
                return vscode.Uri.file('/mock/workspace');
            }
        }
        const envManager = new TestEnvironmentManager(mockPixi, mockContext, undefined, mockExec);

        await envManager.deactivate(true);

        assert.strictEqual(clearCalled, true, 'Collection should be cleared');
        assert.strictEqual(storedEnv, undefined, 'State should be cleared');
    });
});

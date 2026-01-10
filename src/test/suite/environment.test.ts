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
                clear: () => { },
                persistent: true
            },
            workspaceState: {
                update: () => Promise.resolve(),
                get: () => undefined
            },
            subscriptions: []
        };

        const mockExec = async (cmd: string, opts: any) => {
            if (cmd.includes('info --json')) {
                return {
                    stdout: JSON.stringify({ environments_info: [{ name: 'default' }, { name: 'pixi' }] }),
                    stderr: ''
                };
            }
            if (cmd.includes('shell-hook')) {
                return {
                    stdout: JSON.stringify({
                        environment_variables: {
                            PATH: "/pixi/env/bin:/usr/bin",
                            CONDA_PREFIX: "/pixi/env"
                        }
                    }),
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

        await envManager.activate(true);

        assert.strictEqual(envVarsReference.get('CONDA_PREFIX'), '/pixi/env');

        // Verify pixi bin is in PATH
        const pathVar = envVarsReference.get('PATH');
        assert.ok(pathVar?.includes('/mock/workspace/.pixi/bin'), 'PATH should include pixi bin directory');
    });

    test('AutoActivate restores environment from state', async () => {
        const envVarsReference = new Map<string, string>();
        let storedEnv = 'pixi';
        const mockContext: any = {
            environmentVariableCollection: {
                replace: (key: string, value: string) => {
                    envVarsReference.set(key, value);
                },
                clear: () => { },
                persistent: true
            },
            workspaceState: {
                get: (key: string) => {
                    if (key === 'pixiSelectedEnvironment') {return storedEnv;}
                    return undefined;
                },
                update: (key: string, value: string) => {
                    storedEnv = value;
                    return Promise.resolve();
                }
            },
            subscriptions: []
        };

        const mockExec = async (cmd: string, opts: any) => {
            return {
                stdout: JSON.stringify({
                    environment_variables: {
                        PATH: "/pixi/env/pixi/bin:/usr/bin",
                        CONDA_PREFIX: "/pixi/env/pixi"
                    }
                }),
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

        assert.strictEqual(envVarsReference.get('CONDA_PREFIX'), '/pixi/env/pixi');
    });

    test('getEnvironments respects showDefaultEnvironment setting', async () => {
        const mockExec = async (cmd: string) => {
            return {
                stdout: JSON.stringify({
                    environments_info: [
                        { name: 'default' },
                        { name: 'other' }
                    ]
                }),
                stderr: ''
            };
        };

        const mockPixi = new MockPixiManager();
        mockPixi.getPixiPath = () => '/mock/workspace/.pixi/bin/pixi';

        const mockContext: any = {
            environmentVariableCollection: {
                replace: () => { },
                clear: () => { },
                persistent: true
            },
            workspaceState: {
                get: () => undefined,
                update: () => Promise.resolve()
            },
            subscriptions: []
        };

        class TestEnvironmentManager extends EnvironmentManager {
            public override getWorkspaceFolderURI(): vscode.Uri {
                return vscode.Uri.file('/mock/workspace');
            }
        }

        const envManager = new TestEnvironmentManager(mockPixi, mockContext, undefined);
        (envManager as any)._exec = mockExec;

        // Ensure config is false initially
        const config = vscode.workspace.getConfiguration('pixi');
        await config.update('showDefaultEnvironment', false, vscode.ConfigurationTarget.Global);

        // Test Default (False)
        const envsFiltered = await (envManager as any).getEnvironments();
        assert.ok(!envsFiltered.includes('default'), 'Should filter default by default');
        assert.ok(envsFiltered.includes('other'), 'Should keep other');

        // Update Config to True
        await config.update('showDefaultEnvironment', true, vscode.ConfigurationTarget.Global);

        // Test True
        const envsShown = await (envManager as any).getEnvironments();
        assert.ok(envsShown.includes('default'), 'Should show default if configured');
        assert.ok(envsShown.includes('other'), 'Should keep other');

        // Cleanup
        await config.update('showDefaultEnvironment', undefined, vscode.ConfigurationTarget.Global);
    });

    test('Deactivate clears environment and state', async () => {
        let storedEnv: string | undefined = 'pixi';
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
                    if (key === 'pixiSelectedEnvironment') {storedEnv = value;}
                    return Promise.resolve();
                }
            },
            subscriptions: []
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

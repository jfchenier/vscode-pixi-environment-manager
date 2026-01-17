
import * as assert from 'assert';
import * as vscode from 'vscode';
import { EnvironmentManager as RealEnvironmentManager } from '../../environment'; // Import real type
const proxyquire = require('proxyquire').noCallThru();

// Mock dependencies
const mockFs = {
    existsSync: (path: string) => {
        if (path.includes('.pixi/envs/default')) { return true; }
        if (path.includes('.pixi/envs/pixi')) { return true; } // Mock pixi env existence
        return true; // Default to true for legacy tests unless specific path needed
    }
};

// Load EnvironmentManager with mocks
const { EnvironmentManager } = proxyquire('../../environment', {
    'fs': mockFs,
    'vscode': vscode // Pass real vscode to allow normal behavior
});

// Import PixiManager normally
import { PixiManager } from '../../pixi';

class MockPixiManager extends PixiManager {
    public override async isPixiInstalled(): Promise<boolean> {
        return true;
    }
    public override getPixiPath(): string {
        return '/mock/pixi';
    }
}

// Helper to cast the proxied class to the real type for TS
const MockedEnvironmentManager = EnvironmentManager as typeof RealEnvironmentManager;

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

        class TestEnvironmentManager extends MockedEnvironmentManager {
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
                    if (key === 'pixiSelectedEnvironment') { return storedEnv; }
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

        class TestEnvironmentManager extends MockedEnvironmentManager {
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

        class TestEnvironmentManager extends MockedEnvironmentManager {
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
                    if (key === 'pixiSelectedEnvironment') { storedEnv = value; }
                    return Promise.resolve();
                }
            },
            subscriptions: []
        };

        const mockPixi = new MockPixiManager();
        const mockExec = async () => ({ stdout: '', stderr: '' }); // Unused for deactivate

        class TestEnvironmentManager extends MockedEnvironmentManager {
            public override getWorkspaceFolderURI(): vscode.Uri {
                return vscode.Uri.file('/mock/workspace');
            }
        }
        const envManager = new TestEnvironmentManager(mockPixi, mockContext, undefined, mockExec);

        await envManager.deactivate(true);

        assert.strictEqual(clearCalled, true, 'Collection should be cleared');
        assert.strictEqual(storedEnv, undefined, 'State should be cleared');
    });

    test('checkAndPromptForUpdate prompts if lockfile check fails', async () => {
        let promptShown = false;
        let activateCalled = false;


        const showInfoOriginal = vscode.window.showInformationMessage;

        // Stub real vscode.window
        (vscode.window as any).showInformationMessage = async (msg: string, ...items: string[]) => {
            if (msg.includes('out of sync')) {
                promptShown = true;
                return 'Yes';
            }
            return undefined;
        };

        const mockExec = async (cmd: string) => {
            if (cmd.includes('lock --check')) {

                throw new Error('Lockfile out of sync');
            }
            return { stdout: '', stderr: '' };
        };

        const mockContext: any = {
            environmentVariableCollection: { replace: () => { }, clear: () => { } },
            workspaceState: { get: () => undefined, update: () => Promise.resolve() },
            subscriptions: []
        };

        class TestEnvMgr extends MockedEnvironmentManager {
            public override getWorkspaceFolderURI() { return vscode.Uri.file('/mock/ws'); }
            public override async activate(silent: boolean, forceEnv?: string) {
                activateCalled = true;
            }
            public override getCurrentEnvName() { return 'default'; }
        }

        const envMgr = new TestEnvMgr(new MockPixiManager(), mockContext, undefined, mockExec);

        await envMgr.checkAndPromptForUpdate();

        // Restore
        (vscode.window as any).showInformationMessage = showInfoOriginal;

        assert.ok(promptShown, 'Should prompt user');
        assert.ok(activateCalled, 'Should activate if user selects Yes');
    });

    test('checkAndPromptForUpdate DOES NOT prompt if environment directory is missing', async () => {
        let promptShown = false;

        // Use any to bypass strict overload matching for the mock
        (vscode.window as any).showInformationMessage = async (msg: string) => {
            promptShown = true;
            return undefined;
        };

        const mockExec = async () => ({ stdout: '', stderr: '' });

        // Mock fs.existsSync to return FALSE for env path (default behavior of our mock above is true, needs override?)
        // Our mockFs helper above:
        // if (path.includes('.pixi/envs/pixi')) return true;
        // return true; 

        // Override mock for this specific test
        // Proxyquire uses the SAME mock instance if defined at top level?
        // 'mockFs' is const, but properties can be modified.
        // const mockFs = { existsSync: ... }

        const originalExists = mockFs.existsSync;
        mockFs.existsSync = (p: string) => false; // Return false for everything

        const mockContext: any = {
            environmentVariableCollection: { replace: () => { }, clear: () => { } },
            workspaceState: { get: () => undefined, subscription: [] }, // No saved state -> defaults to 'default'
            subscriptions: []
        };

        class TestEnvMgr extends MockedEnvironmentManager {
            public override getWorkspaceFolderURI() { return vscode.Uri.file('/mock/ws'); }
            public override getCurrentEnvName() { return 'default'; }
        }

        const envMgr = new TestEnvMgr(new MockPixiManager(), mockContext, undefined, mockExec);

        const result = await envMgr.checkAndPromptForUpdate();

        // Restore
        mockFs.existsSync = originalExists;

        assert.strictEqual(result, false);
        assert.strictEqual(promptShown, false, 'Should NOT prompt');
    });

    test('autoActivate should respect defaultEnvironment setting (if no saved state)', async () => {
        const capturedState: { [key: string]: any } = {};
        const mockContext: any = {
            workspaceState: {
                get: (key: string) => capturedState[key],
                update: (key: string, value: any) => {
                    capturedState[key] = value;
                    return Promise.resolve();
                }
            },
            environmentVariableCollection: { clear: () => { }, replace: () => { } },
            subscriptions: []
        };

        const mockExec = async (cmd: string) => {
            if (cmd.includes('info --json')) {
                return {
                    stdout: JSON.stringify({
                        environments_info: [{ name: 'default' }, { name: 'prod' }]
                    }),
                    stderr: ''
                };
            }
            return { stdout: '', stderr: '' };
        };

        const mockPixi = new MockPixiManager();
        mockPixi.getPixiPath = () => '/mock/workspace/.pixi/bin/pixi';

        // Partial mock of vscode to inject defaultEnvironment config just for this test
        const originalGetConfig = vscode.workspace.getConfiguration;
        // @ts-expect-error: Mock implementation doesn't match full VS Code API surface
        vscode.workspace.getConfiguration = (section: string) => {
            if (section === 'pixi') {
                return {
                    get: (key: string, def?: any) => {
                        if (key === 'defaultEnvironment') { return 'prod'; }
                        if (key === 'environment') { return undefined; }
                        return def;
                    },
                    update: () => Promise.resolve()
                } as any;
            }
            return originalGetConfig(section);
        };

        class TestEnvMgr extends MockedEnvironmentManager {
            public override getWorkspaceFolderURI() { return vscode.Uri.file('/mock/ws'); }
            // Stub activate to avoid side effects
            public override async activate(silent: boolean, forceEnv?: string) {
                // Do nothing, just verify state update in autoActivate
            }
        }

        const envMgr = new TestEnvMgr(mockPixi, mockContext, undefined, mockExec);
        await envMgr.autoActivate();

        // Restore
        vscode.workspace.getConfiguration = originalGetConfig;

        assert.strictEqual(capturedState['pixiSelectedEnvironment'], 'prod', 'Should select prod');
    });

    test('autoActivate should override saved state if flag is passed', async () => {
        let savedState = 'dev';
        const capturedState: { [key: string]: any } = {};

        const mockContext: any = {
            workspaceState: {
                get: (key: string) => savedState,
                update: (key: string, value: any) => {
                    savedState = value;
                    capturedState[key] = value;
                    return Promise.resolve();
                }
            },
            environmentVariableCollection: { clear: () => { }, replace: () => { } },
            subscriptions: []
        };

        const mockExec = async (cmd: string) => {
            if (cmd.includes('info --json')) {
                return {
                    stdout: JSON.stringify({
                        environments_info: [{ name: 'default' }, { name: 'prod' }, { name: 'dev' }]
                    }),
                    stderr: ''
                };
            }
            return { stdout: '', stderr: '' };
        };

        const mockPixi = new MockPixiManager();
        mockPixi.getPixiPath = () => '/mock/pixi';

        // Mock config
        const originalGetConfig2 = vscode.workspace.getConfiguration;
        // @ts-expect-error: Mock implementation doesn't match full VS Code API surface
        vscode.workspace.getConfiguration = (section: string) => {
            if (section === 'pixi') {
                return {
                    get: (key: string, def?: any) => {
                        if (key === 'defaultEnvironment') { return 'prod'; }
                        return def;
                    },
                    update: () => Promise.resolve()
                } as any;
            }
            return originalGetConfig2(section);
        };

        class TestEnvMgr extends MockedEnvironmentManager {
            public override getWorkspaceFolderURI() { return vscode.Uri.file('/mock/ws'); }
            public override async activate(silent: boolean, forceEnv?: string) { }
        }

        const envMgr = new TestEnvMgr(mockPixi, mockContext, undefined, mockExec);

        // 1. autoActivate() -> should stay 'dev'
        await envMgr.autoActivate();
        assert.strictEqual(savedState, 'dev'); // Unchanged

        // 2. autoActivate(true) -> should switch to 'prod'
        await envMgr.autoActivate(true);
        // Verify state updated
        assert.strictEqual(savedState, 'prod', 'State should be updated to prod');

        // Restore
        vscode.workspace.getConfiguration = originalGetConfig2;
    });
    test('getEnvironments respects ignoredEnvironments regex setting', async () => {
        const mockExec = async (cmd: string) => {
            return {
                stdout: JSON.stringify({
                    environments_info: [
                        { name: 'default' },
                        { name: 'prod' },
                        { name: 'test-env' },
                        { name: 'ci-env' }
                    ]
                }),
                stderr: ''
            };
        };

        const mockPixi = new MockPixiManager();
        mockPixi.getPixiPath = () => '/mock/pixi';

        const mockContext: any = {
            environmentVariableCollection: { replace: () => { }, clear: () => { } },
            workspaceState: { get: () => undefined, update: () => Promise.resolve() },
            subscriptions: []
        };

        // Stub config
        const originalGetConfig = vscode.workspace.getConfiguration;
        // @ts-expect-error: Mock implementation
        vscode.workspace.getConfiguration = (section: string) => {
            if (section === 'pixi') {
                return {
                    get: (key: string, def?: any) => {
                        if (key === 'showDefaultEnvironment') { return true; }
                        if (key === 'ignoredEnvironments') { return ['^test-.*', 'ci-env']; }
                        return def;
                    },
                    update: () => Promise.resolve()
                } as any;
            }
            return originalGetConfig(section);
        };

        class TestEnvMgr extends MockedEnvironmentManager {
            public override getWorkspaceFolderURI() { return vscode.Uri.file('/mock/ws'); }
        }

        const envMgr = new TestEnvMgr(mockPixi, mockContext, undefined);
        (envMgr as any)._exec = mockExec;

        const envs = await envMgr.getEnvironments();

        // Restore
        vscode.workspace.getConfiguration = originalGetConfig;

        assert.ok(envs.includes('default'), 'Should include default');
        assert.ok(envs.includes('prod'), 'Should include prod');
        assert.ok(!envs.includes('test-env'), 'Should ignore test-env (regex match)');
        assert.ok(!envs.includes('ci-env'), 'Should ignore ci-env (exact match)');
    });
});

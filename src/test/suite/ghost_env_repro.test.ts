
import * as assert from 'assert';
import * as vscode from 'vscode';
import { EnvironmentManager as RealEnvironmentManager } from '../../environment';
const proxyquire = require('proxyquire').noCallThru();

// Mock dependencies
const mockFs = {
    existsSync: (path: string) => {
        // Simulate .pixi/envs including default NOT existing
        if (path.includes('.pixi/envs/default')) { return false; }
        // Simulate pixi.toml existing
        if (path.endsWith('pixi.toml')) { return true; }
        return false;
    }
};

// Load EnvironmentManager with mocks
const { EnvironmentManager } = proxyquire('../../environment', {
    'fs': mockFs,
    'vscode': vscode
});

import { PixiManager } from '../../pixi';

class MockPixiManager extends PixiManager {
    public override async isPixiInstalled(): Promise<boolean> {
        return false; // User deleted .pixi, so pixi binary is gone too
    }
    public override getPixiPath(): string {
        return '/mock/pixi';
    }
    // ensurePixi should just succeed for this test
    public override async ensurePixi(): Promise<void> { }
}

const MockedEnvironmentManager = EnvironmentManager as typeof RealEnvironmentManager;

suite('Ghost Environment Reproduction Suite', () => {

    test('AutoActivate triggers install if default environment folder AND pixi binary are missing', async () => {
        let installCalled = false;
        let ensurePixiCalled = false;

        const mockContext: any = {
            environmentVariableCollection: {
                replace: () => { },
                clear: () => { },
                persistent: true
            },
            workspaceState: {
                get: (key: string) => {
                    if (key === 'pixiSelectedEnvironment') { return 'default'; }
                    return undefined;
                },
                update: () => Promise.resolve()
            },
            subscriptions: []
        };

        // Stub config to simulate defaultEnvironment being set
        const originalGetConfig = vscode.workspace.getConfiguration;
        // @ts-expect-error: Mock implementation
        vscode.workspace.getConfiguration = (section: string) => {
            if (section === 'pixi') {
                return {
                    get: (key: string, def?: any) => {
                        if (key === 'defaultEnvironment') { return 'default'; }
                        return def;
                    },
                    update: () => Promise.resolve()
                } as any;
            }
            return originalGetConfig(section);
        };


        const mockExec = async (cmd: string) => {
            // getEnvironments will return empty because isPixiInstalled is false, so exec won't even run usually.
            // But if it does:
            return { stdout: '', stderr: '' };
        };

        const mockPixi = new MockPixiManager();
        mockPixi.ensurePixi = async () => { ensurePixiCalled = true; };

        class TestEnvironmentManager extends MockedEnvironmentManager {
            public override getWorkspaceFolderURI(): vscode.Uri {
                return vscode.Uri.file('/mock/workspace');
            }

            // We want to detect if runInstallInTerminal is called
            // Or activate(false) which calls runInstallInTerminal
            public override async activate(silent: boolean, forceEnv?: string) {
                // If we get here with silent=false, it means the fix worked (it decided to install)
                if (silent === false) {
                    installCalled = true;
                }
                // Call super if possible? No, we mocked it.
            }
        }

        const envManager = new TestEnvironmentManager(mockPixi, mockContext, undefined, mockExec);

        // Run autoActivate
        await envManager.autoActivate();

        // Restore
        vscode.workspace.getConfiguration = originalGetConfig;

        assert.strictEqual(ensurePixiCalled, true, 'Should ensure Pixi is installed');
        assert.strictEqual(installCalled, true, 'Should trigger non-silent activation (install)');
    });
});

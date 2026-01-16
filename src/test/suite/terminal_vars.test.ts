
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

suite('Terminal Variables Test Suite', () => {

    test('Activate clears persistent terminal variables (TERM, TERMINFO)', async () => {
        // Simulate a "polluted" state from a previous session
        const storedVars = new Map<string, string>([
            ['TERM', 'xterm-256color'],
            ['TERMINFO', '/bad/path/terminfo'],
            ['EXISTING_VAR', 'keep_me_if_reapplied']
        ]);

        let clearCalled = false;

        const mockContext: any = {
            environmentVariableCollection: {
                replace: (key: string, value: string) => {
                    storedVars.set(key, value);
                },
                get: (key: string) => ({ value: storedVars.get(key) }),
                clear: () => {
                    clearCalled = true;
                    storedVars.clear();
                },
                delete: (key: string) => storedVars.delete(key),
                persistent: true
            },
            workspaceState: {
                get: (key: string) => {
                    // Simulate cached environment to load
                    if (key === 'pixi.cachedEnv') {
                        return {
                            envName: 'env',
                            envVars: {
                                'PATH': '/new/path',
                                // Simulating they were stripped from cache or skipped.
                                // Put one in cache to verify the "skip from cache" logic.
                                'TERM': 'bad-term-from-cache'
                            }
                        };
                    }
                    if (key === 'pixiSelectedEnvironment') { return 'env'; }
                    return undefined;
                },
                update: () => Promise.resolve()
            },
            subscriptions: []
        };

        const mockExec = async (cmd: string) => {
            if (cmd.includes('info --json')) {
                return { stdout: JSON.stringify({ environments_info: [{ name: 'env', prefix: '/mock/env' }] }), stderr: '' };
            }
            if (cmd.includes('shell-hook')) {
                return { stdout: JSON.stringify({ environment_variables: { 'PATH': '/new/path' } }), stderr: '' };
            }
            return { stdout: '', stderr: '' };
        };
        const mockPixi = new MockPixiManager();

        class TestEnvironmentManager extends EnvironmentManager {
            public override getWorkspaceFolderURI(): vscode.Uri {
                return vscode.Uri.file('/mock/workspace');
            }
        }

        const envManager = new TestEnvironmentManager(mockPixi, mockContext, undefined, mockExec);

        // Run activate
        await envManager.activate(true);

        // Assertions
        assert.strictEqual(clearCalled, true, 'EnvironmentVariableCollection.clear() should be called start of activation');

        // TERM should be GONE
        assert.strictEqual(storedVars.has('TERM'), false, 'TERM should be removed from collection');
        assert.strictEqual(storedVars.has('TERMINFO'), false, 'TERMINFO should be removed from collection');

        // PATH should be applied (with pixi bin prepended)
        assert.strictEqual(storedVars.get('PATH'), '/mock:/new/path', 'Valid variables should be applied');
    });
});

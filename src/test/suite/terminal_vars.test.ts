
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
                    // Simulate that we have a cached environment to load
                    if (key === 'pixi.cachedEnv') {
                        return {
                            envName: 'env',
                            envVars: {
                                'PATH': '/new/path',
                                // Note: TERM/TERMINFO are NOT in cache here (simulating we stripped them from cache source)
                                // OR even if they ARE in cache, the activate logic should skip them.
                                // Let's put one in cache to verify the "skip from cache" logic too
                                'TERM': 'bad-term-from-cache'
                            }
                        };
                    }
                    if (key === 'pixiSelectedEnvironment') {return 'env';}
                    return undefined;
                },
                update: () => Promise.resolve()
            },
            subscriptions: []
        };

        const mockExec = async () => ({ stdout: '', stderr: '' });
        const mockPixi = new MockPixiManager();

        class TestEnvironmentManager extends EnvironmentManager {
            public override getWorkspaceFolderURI(): vscode.Uri {
                return vscode.Uri.file('/mock/workspace');
            }
        }

        const envManager = new TestEnvironmentManager(mockPixi, mockContext, undefined, mockExec);

        // Run activate
        // correctly implemented activate() should:
        // 1. Call clear() on the collection (removing the initial pollution)
        // 2. Load from cache (applying PATH, but IGNORING the bad-term-from-cache)
        await envManager.activate(true);

        // Assertions
        assert.strictEqual(clearCalled, true, 'EnvironmentVariableCollection.clear() should be called start of activation');

        // TERM should be GONE (cleared from initial state, and skipped during cache apply)
        assert.strictEqual(storedVars.has('TERM'), false, 'TERM should be removed from collection');
        assert.strictEqual(storedVars.has('TERMINFO'), false, 'TERMINFO should be removed from collection');

        // PATH should be present
        assert.strictEqual(storedVars.get('PATH'), '/new/path', 'Valid variables should be applied');
    });
});

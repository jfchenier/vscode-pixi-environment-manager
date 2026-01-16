import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { PixiTaskProvider } from '../../tasks';
import { PixiManager } from '../../pixi';

// Mock PixiManager
class MockPixiManager extends PixiManager {
    constructor() {
        super();
    }
    public getPixiPath(): string | undefined {
        return '/mock/pixi';
    }
}

// Subclass to override exec
class TestPixiTaskProvider extends PixiTaskProvider {
    public mockStdout: string = '[]';

    // Override the protected/private exec. 
    // In TS, we can override private if we cast or if we change source to protected.
    // For now, we assume we might need to cast or use 'any' if it's strict private.
    // But better yet, I will update tasks.ts to make `exec` protected if needed.
    // Actually, let's just use prototype patching or a simpler approach if we don't want to modify source.
    // But modifying source to `protected` is cleaner.
    // Let's assume I'll make it protected in the next step or use `any` trick.

    // Since I cannot easily change the source signature from here without an edit,
    // I will use a spy/stub approach or simple overwrite if allowed.
    // Let's simulate the behavior by overwriting the method on the instance for testing.
}

suite('Pixi Task Provider Test Suite', () => {
    let mockPixiManager: MockPixiManager;

    setup(() => {
        mockPixiManager = new MockPixiManager();
    });

    test('Parses default environment tasks', async () => {
        const provider = new PixiTaskProvider('/root', mockPixiManager);

        // Mock exec
        (provider as any).exec = async (cmd: string) => {
            return {
                stdout: JSON.stringify([
                    {
                        environment: "default",
                        features: [
                            {
                                name: "default",
                                tasks: [
                                    { name: "test", cmd: "pytest" },
                                    { name: "build", cmd: "cargo build" }
                                ]
                            }
                        ]
                    }
                ]),
                stderr: ""
            };
        };

        const tasks = await provider.provideTasks();
        assert.ok(tasks);
        assert.strictEqual(tasks!.length, 2);
        assert.strictEqual(tasks![0].name, 'test');
        assert.strictEqual(tasks![1].name, 'build');

        // Verify command
        const exec = tasks![0].execution as vscode.ShellExecution;
        assert.strictEqual(exec.commandLine, '"/mock/pixi" run test');
    });

    test('Parses multi-environment tasks with suffix and deduplication', async () => {
        const provider = new PixiTaskProvider('/root', mockPixiManager);

        // Mock exec
        (provider as any).exec = async (cmd: string) => {
            return {
                stdout: JSON.stringify([
                    {
                        environment: "default",
                        features: [
                            {
                                name: "default",
                                tasks: [
                                    { name: "test", cmd: "pytest" } // Should appear as "test"
                                ]
                            }
                        ]
                    },
                    {
                        environment: "cuda",
                        features: [
                            {
                                name: "default", // Inherited feature
                                tasks: [
                                    { name: "test", cmd: "pytest" } // Should be IGNORED (deduplicated)
                                ]
                            },
                            {
                                name: "cuda_feat",
                                tasks: [
                                    { name: "train", cmd: "python train.py" } // Should appear as "train (cuda)"
                                ]
                            }
                        ]
                    }
                ]),
                stderr: ""
            };
        };

        const tasks = await provider.provideTasks();
        assert.ok(tasks);

        // Expected: "test" (default), "train (cuda)" (cuda)
        // "test" (cuda) should be skipped because it belongs to 'default' feature which is in default env

        // Wait, my deduplication logic is based on FEATURE NAME.
        // In default env, feature is "default".
        // In cuda env, it inherits "default" feature (containing "test").
        // So my logic `if (!isDefault && defaultFeatureNames.has(feature.name)) continue;` logic should work.

        const names = tasks!.map(t => t.name).sort();
        assert.deepStrictEqual(names, ['test', 'train (cuda)']);

        const cudaTask = tasks!.find(t => t.name === 'train (cuda)');
        assert.ok(cudaTask);
        const exec = cudaTask!.execution as vscode.ShellExecution;
        assert.ok(exec.commandLine && exec.commandLine.includes('-e cuda'), 'Should include -e cuda arg');
    });

    test('Filters hidden tasks', async () => {
        const provider = new PixiTaskProvider('/root', mockPixiManager);

        (provider as any).exec = async (cmd: string) => {
            return {
                stdout: JSON.stringify([
                    {
                        environment: "default",
                        features: [
                            {
                                name: "default",
                                tasks: [
                                    { name: "visible", cmd: "echo hi" },
                                    { name: "_hidden", cmd: "echo secret" }
                                ]
                            }
                        ]
                    }
                ]),
                stderr: ""
            };
        };

        const tasks = await provider.provideTasks();
        assert.ok(tasks);
        assert.strictEqual(tasks!.length, 1);
        assert.strictEqual(tasks![0].name, 'visible');
    });
});

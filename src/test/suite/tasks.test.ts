import * as assert from 'assert';
import * as vscode from 'vscode';
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

        // Expected: "test" (default), "train (cuda)" (cuda)
        // "test" (cuda) should be skipped because it belongs to 'default' feature which is in default env

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

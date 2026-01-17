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

    let mockEnvManager: any;

    setup(() => {
        mockPixiManager = new MockPixiManager();
        mockEnvManager = {
            getCurrentEnvName: () => undefined
        };
    });

    test('Parses default environment tasks', async () => {
        const provider = new PixiTaskProvider('/root', mockPixiManager, mockEnvManager);

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

    test('Deduplicates tasks based on priority (Default Env)', async () => {
        const provider = new PixiTaskProvider('/root', mockPixiManager, mockEnvManager);

        // Mock: Task exists in Default and Custom env.
        // Current Env is undefined (so Default should win).
        (provider as any).exec = async (cmd: string) => {
            return {
                stdout: JSON.stringify([
                    { environment: "default", features: [{ name: "def", tasks: [{ name: "test", cmd: "echo default" }] }] },
                    { environment: "custom", features: [{ name: "cust", tasks: [{ name: "test", cmd: "echo custom" }] }] }
                ]),
                stderr: ""
            };
        };

        const tasks = await provider.provideTasks();
        assert.ok(tasks);

        // Should only show one "test" (from default)
        const tests = tasks!.filter(t => t.name.startsWith('test'));
        assert.strictEqual(tests.length, 1);
        assert.strictEqual(tests[0].name, 'test');

        const exec = tests[0].execution as vscode.ShellExecution;
        // Default env arg is usually empty or depends on implementation. 
        // Our implementation: isDefault ? undefined : env.environment
        // "run test" (no -e)
        assert.strictEqual(exec.commandLine, '"/mock/pixi" run test');
    });

    test('Deduplicates tasks based on priority (Active Env - Default Wins)', async () => {
        mockEnvManager.getCurrentEnvName = () => 'custom';
        const provider = new PixiTaskProvider('/root', mockPixiManager, mockEnvManager);

        // Mock: Task exists in Default and Custom env.
        // Current Env is 'custom'.
        // PRIORITY CHANGE: Default should win despite 'custom' being active.
        (provider as any).exec = async (cmd: string) => {
            return {
                stdout: JSON.stringify([
                    { environment: "default", features: [{ name: "def", tasks: [{ name: "test", cmd: "echo default" }] }] },
                    { environment: "custom", features: [{ name: "cust", tasks: [{ name: "test", cmd: "echo custom" }] }] }
                ]),
                stderr: ""
            };
        };

        const tasks = await provider.provideTasks();
        assert.ok(tasks);

        // Should only show one "test" (from default)
        const tests = tasks!.filter(t => t.name.startsWith('test'));
        assert.strictEqual(tests.length, 1);

        // Expect 'test' (from default) not 'test (custom)'
        assert.strictEqual(tests[0].name, 'test');

        const exec = tests[0].execution as vscode.ShellExecution;
        // Should NOT include -e custom
        assert.ok(exec.commandLine && !exec.commandLine.includes('-e custom'), 'Should not include -e custom arg (Default priority)');
    });

    test('Shows all variants if no priority match', async () => {
        mockEnvManager.getCurrentEnvName = () => 'other';
        const provider = new PixiTaskProvider('/root', mockPixiManager, mockEnvManager);

        // Mock: Task in EnvA, EnvB. No Default. Current is Other.
        (provider as any).exec = async (cmd: string) => {
            return {
                stdout: JSON.stringify([
                    { environment: "envA", features: [{ name: "a", tasks: [{ name: "test", cmd: "echo A" }] }] },
                    { environment: "envB", features: [{ name: "b", tasks: [{ name: "test", cmd: "echo B" }] }] }
                ]),
                stderr: ""
            };
        };

        const tasks = await provider.provideTasks();
        assert.ok(tasks);

        const names = tasks!.map(t => t.name).sort();
        assert.deepStrictEqual(names, ['test (envA)', 'test (envB)']);
    });

    test('Filters hidden tasks', async () => {
        const provider = new PixiTaskProvider('/root', mockPixiManager, mockEnvManager);
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

    test('Respects ignoredEnvironments setting', async () => {
        const provider = new PixiTaskProvider('/root', mockPixiManager, mockEnvManager);

        (provider as any).exec = async (cmd: string) => {
            return {
                stdout: JSON.stringify([
                    {
                        environment: "default",
                        features: [{ name: "default", tasks: [{ name: "task_default", cmd: "echo" }] }]
                    },
                    {
                        environment: "ignored_env",
                        features: [{ name: "feat", tasks: [{ name: "task_ignored", cmd: "echo" }] }]
                    },
                    {
                        environment: "visible_env",
                        features: [{ name: "feat2", tasks: [{ name: "task_visible", cmd: "echo" }] }]
                    }
                ]),
                stderr: ""
            };
        };

        // Stub config
        const originalGetConfig = vscode.workspace.getConfiguration;
        // @ts-expect-error: Mock implementation
        vscode.workspace.getConfiguration = (section: string) => {
            if (section === 'pixi') {
                return {
                    get: (key: string, def?: any) => {
                        if (key === 'ignoredEnvironments') {return ['ignored_.*'];}
                        return def;
                    }
                } as any;
            }
            return originalGetConfig(section);
        };

        const tasks = await provider.provideTasks();

        // Restore
        vscode.workspace.getConfiguration = originalGetConfig;

        assert.ok(tasks);
        const names = tasks!.map(t => t.name);
        assert.ok(names.includes('task_default'));
        assert.ok(names.includes('task_visible (visible_env)'));
        assert.ok(!names.includes('task_ignored (ignored_env)'), 'Should ignore task from ignored environment');
    });
});

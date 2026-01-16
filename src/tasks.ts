import * as vscode from 'vscode';
import { PixiManager } from './pixi';


interface PixiTaskDefinition extends vscode.TaskDefinition {
    type: 'pixi';
    task: string;
    environment?: string;
}

interface PixiTaskJson {
    name: string;
    cmd?: string;
    description?: string;
    depends_on?: string[];
}

interface PixiEnvJson {
    environment: string;
    features: {
        name: string;
        tasks: PixiTaskJson[];
    }[];
}

export class PixiTaskProvider implements vscode.TaskProvider {
    static readonly PixiType = 'pixi' as const;
    private pixiPromise: Thenable<vscode.Task[]> | undefined = undefined;

    constructor(private workspaceRoot: string, private pixiManager: PixiManager) { }

    public provideTasks(): Thenable<vscode.Task[]> | undefined {
        if (!this.pixiPromise) {
            this.pixiPromise = this.getPixiTasks();
        }
        return this.pixiPromise;
    }

    public resolveTask(_task: vscode.Task): vscode.Task | undefined {
        const task = _task.definition.task;
        if (task) {
            const definition: PixiTaskDefinition = <any>_task.definition;
            const envSuffix = definition.environment ? ` (${definition.environment})` : '';
            return this.getTask(definition.task, definition.environment, definition.task ? `run ${definition.task}${envSuffix}` : 'run', definition);
        }
        return undefined;
    }

    public invalidate() {
        this.pixiPromise = undefined;
    }

    private async getPixiTasks(): Promise<vscode.Task[]> {
        const pixiPath = this.pixiManager.getPixiPath();
        if (!pixiPath) {
            return [];
        }

        const tasks: vscode.Task[] = [];
        try {
            // Run `pixi task list --json`
            const command = `"${pixiPath}" task list --json`;
            const { stdout } = await this.exec(command, { cwd: this.workspaceRoot });

            // Clean output (remove warnings)
            const jsonStart = stdout.indexOf('[');
            if (jsonStart === -1) {
                return [];
            }
            const jsonStr = stdout.substring(jsonStart);
            const envs: PixiEnvJson[] = JSON.parse(jsonStr);

            const seenTaskKeys = new Set<string>();

            // Identify default features
            const defaultEnv = envs.find(e => e.environment === 'default') || envs[0];
            const defaultFeatureNames = new Set<string>();
            if (defaultEnv) {
                for (const feature of defaultEnv.features) {
                    defaultFeatureNames.add(feature.name);
                }
            }

            for (const env of envs) {
                const isDefault = env.environment === 'default';

                for (const feature of env.features) {
                    // Skip features that are already covered by default environment
                    if (!isDefault && defaultFeatureNames.has(feature.name)) {
                        continue;
                    }

                    for (const taskJson of feature.tasks) {
                        if (taskJson.name.startsWith('_')) {
                            continue;
                        }
                        // Unique key: name + env
                        // For default tasks: "taskname"
                        // For other envs: "taskname (envname)"
                        const taskName = isDefault ? taskJson.name : `${taskJson.name} (${env.environment})`;

                        // We filter duplicates based on this display name
                        if (!seenTaskKeys.has(taskName)) {
                            seenTaskKeys.add(taskName);
                            tasks.push(this.getTask(
                                taskJson.name,
                                isDefault ? undefined : env.environment,
                                taskJson.cmd || 'complex',
                                {
                                    type: PixiTaskProvider.PixiType,
                                    task: taskJson.name,
                                    environment: isDefault ? undefined : env.environment
                                },
                                taskJson.description
                            ));
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Failed to fetch pixi tasks", e);
        }
        return tasks;
    }

    private getTask(name: string, environment: string | undefined, cmd: string, definition: PixiTaskDefinition, description?: string): vscode.Task {
        const pixiPath = this.pixiManager.getPixiPath() || 'pixi';

        // Execute task: pixi run -e <env> <task_name>
        // Note: pixi run -e default <task> is valid, but we omit -e for default to be cleaner?
        // Actually, explicit is better, but existing logic omitted it.
        // If environment is undefined, it runs in default/selected env.

        const envArg = environment ? ` -e ${environment}` : '';
        const commandLine = `"${pixiPath}" run${envArg} ${name}`;

        const execution = new vscode.ShellExecution(commandLine, {
            cwd: this.workspaceRoot
        });

        // Display name: "task" or "task (env)"
        const displayName = environment ? `${name} (${environment})` : name;

        const task = new vscode.Task(
            definition,
            vscode.TaskScope.Workspace,
            displayName,
            PixiTaskProvider.PixiType,
            execution
        );

        task.group = vscode.TaskGroup.Build;
        task.detail = description || cmd;
        return task;
    }

    private async exec(command: string, options: any): Promise<{ stdout: string, stderr: string }> {
        const cp = require('child_process');
        const util = require('util');
        const exec = util.promisify(cp.exec);
        return await exec(command, options);
    }
}

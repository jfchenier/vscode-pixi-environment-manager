
import * as vscode from 'vscode';
import { PixiManager } from './pixi';
import { EnvironmentManager } from './environment';

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

    constructor(private workspaceRoot: string, private pixiManager: PixiManager, private environmentManager: EnvironmentManager) { }

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
            const taskCmd = definition.task ? `run ${definition.task}${envSuffix}` : 'run';
            return this.getTask(definition.task, definition.environment, taskCmd, definition);
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

            const config = vscode.workspace.getConfiguration('pixi');
            const ignoredPatterns = config.get<string[]>('ignoredEnvironments', []);
            const currentEnv = this.environmentManager.getCurrentEnvName();

            // Collect all potential tasks
            // Map<TaskName, Map<EnvName, TaskObject>>
            const potentialTasks = new Map<string, Map<string, { cmd: string, desc?: string, def: PixiTaskDefinition }>>();

            for (const env of envs) {
                // Check if environment is ignored
                let isIgnored = false;
                for (const pattern of ignoredPatterns) {
                    try {
                        if (new RegExp(pattern).test(env.environment)) {
                            isIgnored = true;
                            break;
                        }
                    } catch {
                        console.warn(`Invalid regex in pixi.ignoredEnvironments: ${pattern}`);
                    }
                }
                if (isIgnored) {
                    continue;
                }

                const isDefaultEnv = env.environment === 'default';

                for (const feature of env.features) {
                    for (const taskJson of feature.tasks) {
                        if (taskJson.name.startsWith('_')) {
                            continue;
                        }

                        if (!potentialTasks.has(taskJson.name)) {
                            potentialTasks.set(taskJson.name, new Map());
                        }

                        const envMap = potentialTasks.get(taskJson.name)!;
                        // Avoid duplicates within the same environment (shouldn't happen in valid pixi json but safe to check)
                        if (!envMap.has(env.environment)) {
                            envMap.set(env.environment, {
                                cmd: taskJson.cmd || 'complex',
                                desc: taskJson.description,
                                def: {
                                    type: PixiTaskProvider.PixiType,
                                    task: taskJson.name,
                                    environment: isDefaultEnv ? undefined : env.environment
                                }
                            });
                        }
                    }
                }
            }

            // Apply priority logic
            // 1. Current Active Environment
            // 2. Default Environment
            // 3. All variants

            for (const [taskName, envMap] of potentialTasks) {
                let selectedEnvs: string[] = [];

                if (envMap.has('default')) {
                    selectedEnvs = ['default'];
                } else if (currentEnv && envMap.has(currentEnv)) {
                    selectedEnvs = [currentEnv];
                } else {
                    selectedEnvs = Array.from(envMap.keys());
                }

                for (const envName of selectedEnvs) {
                    const info = envMap.get(envName)!;
                    // If selected is default, we don't show (default) suffix usually, unless specific?
                    // Existing logic: isDefault ? undefined : env.environment

                    tasks.push(this.getTask(
                        taskName,
                        info.def.environment, // Passed correctly from collection above
                        info.cmd,
                        info.def,
                        info.desc
                    ));
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

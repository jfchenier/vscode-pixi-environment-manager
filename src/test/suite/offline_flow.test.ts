
import * as assert from 'assert';

const proxyquire = require('proxyquire').noCallThru();

suite('Offline Flow Test Suite', () => {

    let terminalSentText: string[] = [];
    let execCommands: string[] = [];
    let showQuickPickResults: string[] = []; // Stack of results to return
    let showOpenDialogResult: any[] | undefined = undefined;

    let commandCalls: string[] = [];
    let mockConfig: { [key: string]: any } = {};

    let lastTaskExecution: any;
    let capturedTasks: any[] = [];

    // Mock VS Code
    const vscodeMock = {
        ExtensionContext: class { },
        OutputChannel: class { },
        Uri: { file: (f: string) => ({ fsPath: f, scheme: 'file', toString: () => f }) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
            getWorkspaceFolder: (uri: any) => ({ uri: { fsPath: '/mock/workspace' }, index: 0, name: 'Workspace' }),
            getConfiguration: () => ({
                get: (key: string, def?: any) => {
                    if (key in mockConfig) { return mockConfig[key]; }
                    if (key === 'offlineEnvironmentName') { return 'env'; }
                    return def;
                },
                update: () => Promise.resolve()
            })
        },
        commands: {
            executeCommand: (cmd: string, ...args: any[]) => {
                commandCalls.push(cmd);
                return Promise.resolve();
            }
        },
        ProgressLocation: { Notification: 15 },
        window: {
            showInformationMessage: () => Promise.resolve('Reload'), // Auto-reload confirm
            showErrorMessage: (msg: string) => console.error(msg), // Fail test if error?
            createTerminal: (name: string) => {
                const term = {
                    show: () => { },
                    sendText: (txt: string) => terminalSentText.push(txt),
                    dispose: () => { },
                    exitStatus: { code: 0 } // Simulate success
                };
                createdTerminals.push(term);
                return term;
            },
            withProgress: async (opts: any, task: any) => await task({ report: () => { } }),
            showQuickPick: (items: any) => {
                const res = showQuickPickResults.shift();
                return Promise.resolve(res);
            },
            showInputBox: () => Promise.resolve('mock-input'),
            showWarningMessage: async (msg: string, ...items: string[]) => {
                return Promise.resolve("Yes");
            },
            showOpenDialog: () => Promise.resolve(showOpenDialogResult),
            onDidCloseTerminal: (listener: (t: any) => void) => {
                return { dispose: () => { } };
            },
            createStatusBarItem: () => ({
                show: () => { },
                hide: () => { },
                dispose: () => { },
                text: '',
                command: '',
                tooltip: ''
            })
        },
        ShellExecution: class {
            constructor(public commandLine: string, public options?: any) { }
        },
        Task: class {
            constructor(public definition: any, public scope: any, public name: string, public source: string, public execution: any) {
                capturedTasks.push(this);
            }
        },
        TaskScope: { Workspace: 1 },
        tasks: {
            executeTask: (task: any) => {
                const execution = { task }; // Stable identity
                lastTaskExecution = execution;
                return Promise.resolve(execution);
            },
            onDidEndTaskProcess: (listener: (e: any) => void) => {
                const exec = lastTaskExecution || {};
                setTimeout(() => listener({ execution: exec, exitCode: 0 }), 10);
                return { dispose: () => { } };
            }
        },
        TaskRevealKind: { Always: 1 },
        TaskPanelKind: { Dedicated: 1 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ConfigurationTarget: { Workspace: 2, Global: 1 }
    };

    let createdTerminals: any[] = [];

    // Mock FS
    const fsMock = {
        existsSync: (p: string) => {
            if (p.includes('pixi.toml')) { return true; }
            if (p.endsWith('activate.sh') || p.endsWith('activate.bat')) { return true; } // Mock activation script existence
            if (p.includes('.pixi/envs')) { return true; }
            return false;
        },
        promises: {
            readFile: (p: string) => {
                if (p.includes('pixi.toml')) {
                    // Return valid TOML with platforms
                    return Promise.resolve('platforms = ["linux-64", "win-64"]\n');
                }
                return Promise.resolve('');
            },
            rm: () => Promise.resolve(),
            mkdir: () => Promise.resolve(),
            writeFile: () => Promise.resolve()
        },
        mkdirSync: () => { },
        rmSync: () => { }
    };

    // Load OfflineManager with mocks
    const { OfflineManager } = proxyquire('../../features/offline', {
        'vscode': vscodeMock,
        'fs': fsMock
    });

    // Mock PixiManager
    class MockPixiManager {
        public async isPixiInstalled() { return true; }
        public getPixiPath() { return '/mock/pixi'; }
    }

    setup(() => {
        terminalSentText = [];
        capturedTasks = [];
        execCommands = [];
        showQuickPickResults = [];
        showOpenDialogResult = undefined;
        createdTerminals = [];
        commandCalls = [];
        mockConfig = {};
    });

    test('Generate Offline Environment: Flows correctly', async () => {
        const mockExec = async (cmd: string) => {
            execCommands.push(cmd);
            if (cmd.indexOf('info') !== -1) {
                return { stdout: JSON.stringify({ environments_info: [{ name: 'default' }, { name: 'prod' }] }), stderr: '' };
            }
            if (cmd.indexOf('shell-hook') !== -1) {
                return { stdout: JSON.stringify({ environment_variables: { FOO: "BAR" } }), stderr: '' };
            }
            return { stdout: '', stderr: '' };
        };

        const mockContext = {
            subscriptions: [],
            workspaceState: {
                get: (key: string) => undefined,
                update: () => Promise.resolve()
            }
        } as any;

        const mockEnvManager = {
            getWorkspaceFolderURI: () => vscodeMock.Uri.file('/mock/workspace'),
            exec: mockExec,
            getPixiManager: () => new MockPixiManager(),
            getContext: () => mockContext,
            log: () => { },
            getSafeShellExecutionOptions: () => ({}),
            runInstallInTerminal: () => Promise.resolve(),
            getEnvironments: () => Promise.resolve(['default', 'prod']),
            updateStatusBar: () => { },
            activate: () => Promise.resolve(),
            deactivate: () => Promise.resolve()
        };

        const offlineManager = new OfflineManager(mockEnvManager);

        // Setup user inputs: Select 'prod' environment and 'linux-64' platform
        showQuickPickResults = ['prod', 'linux-64'];

        await offlineManager.generateOfflineEnvironment();

        // Verification

        // 1. Check if pixi-pack install was attempted
        const installCmd = execCommands.find(c => c.includes('add pixi-pack'));
        assert.ok(installCmd, 'Should attempt to install pixi-pack via exec');

        // 2. Check if Tasks were created for install and pack
        // Check that install was called
        // Since runInstallInTerminal is mocked on the envManager passed to OfflineManager, we check the spy/mock logic.
        // We didn't set up a spy, but we can verify execCommands contains the pack command
        // And we can adding a flag to the mockEnvManager.runInstallInTerminal in the setup.

        // Check exec commands (pixi use/add)
        const addPack = execCommands.some(c => c.includes('add pixi-pack'));
        // Pack command is run via Task, so check capturedTasks
        const packTask = capturedTasks.find(t => t.name.includes('Pack') && t.execution.commandLine.includes('pixi-pack'));

        if (!addPack || !packTask) {
            console.log('[TESTFAIL] execCommands:', execCommands);
            console.log('[TESTFAIL] capturedTasks:', capturedTasks.map(t => t.name));
        }

        assert.ok(addPack, 'Should equal add pixi-pack command');
        assert.ok(packTask, 'Should trigger pack task');
        assert.ok(packTask.execution.commandLine.includes('--environment prod'), 'Pack task should use correct environment');
        assert.ok(packTask.execution.commandLine.includes('--platform linux-64'), 'Pack task should use correct platform');
    });

    test('Load Offline Environment: Unpacks and Activating', async () => {
        const mockExec = async (cmd: string) => {
            execCommands.push(cmd);
            if (cmd.indexOf('info') !== -1) {
                return { stdout: JSON.stringify({ environments_info: [{ name: 'default' }, { name: 'prod' }] }), stderr: '' };
            }
            if (cmd.indexOf('shell-hook') !== -1) {
                return { stdout: JSON.stringify({ environment_variables: { FOO: "BAR" } }), stderr: '' };
            }
            return { stdout: 'export FOO=BAR', stderr: '' }; // Mock unpacking or activation output
        };

        // Mock context for activation side-effects
        const mockContext = {
            environmentVariableCollection: { clear: () => { }, replace: () => { } },
            workspaceState: { get: () => undefined, update: () => Promise.resolve() },
            subscriptions: []
        };

        const mockEnvManager = {
            getWorkspaceFolderURI: () => vscodeMock.Uri.file('/mock/workspace'),
            exec: mockExec,
            getPixiManager: () => new MockPixiManager(),
            getContext: () => mockContext,
            log: () => { },
            getSafeShellExecutionOptions: () => ({}),
            runInstallInTerminal: () => Promise.resolve(),
            getEnvironments: () => Promise.resolve(['default', 'prod']),
            updateStatusBar: () => { },
            activate: () => Promise.resolve(),
            deactivate: () => Promise.resolve()
        };

        const offlineManager = new OfflineManager(mockEnvManager);

        // Setup User Input: Select a script file
        showOpenDialogResult = [{ fsPath: '/mock/downloaded/env-installer.sh' }];

        await offlineManager.loadOfflineEnvironment();

        // Verification

        // 1. Check unpacking task
        const unpackTask = capturedTasks.find(t => t.name.includes('Unpack'));
        assert.ok(unpackTask, 'Should create an Unpack task');

        const cmdLine = unpackTask.execution.commandLine;
        assert.ok(cmdLine.includes('env-installer.sh'), 'Task should execute the selected script');
        assert.ok(cmdLine.includes('--output-directory'), 'Should specify output directory');

        // 2. Check activation was triggered
        const isWin = process.platform === 'win32';
        const expectedCmdPart = isWin ? 'set' : 'printenv';
        const expectedScript = isWin ? 'activate.bat' : 'activate.sh';

        const activateCmd = execCommands.find(c => c.includes(expectedCmdPart) && c.includes(expectedScript));
        assert.ok(activateCmd, 'Should attempt to activate and capture environment after unpacking');

        // 3. Verify Reload Window
        const reloadCall = commandCalls.find(c => c === 'workbench.action.reloadWindow');
        assert.ok(reloadCall, 'Should reload window after loading offline environment');
    });

    test('Load Offline Environment: Auto-Reloads if configured', async () => {
        mockConfig['autoReload'] = true;

        const mockExec = async (cmd: string) => {
            if (cmd.indexOf('info') !== -1) {
                return { stdout: JSON.stringify({ environments_info: [{ name: 'default' }, { name: 'prod' }] }), stderr: '' };
            }
            if (cmd.indexOf('shell-hook') !== -1) {
                return { stdout: JSON.stringify({ environment_variables: { FOO: "BAR" } }), stderr: '' };
            }
            return { stdout: 'export FOO=BAR', stderr: '' };
        };
        const mockContext = {
            environmentVariableCollection: { clear: () => { }, replace: () => { } },
            workspaceState: { get: () => undefined, update: () => Promise.resolve() },
            subscriptions: []
        };

        const mockEnvManager = {
            getWorkspaceFolderURI: () => vscodeMock.Uri.file('/mock/workspace'),
            exec: mockExec,
            getPixiManager: () => new MockPixiManager(),
            getContext: () => mockContext,
            log: () => { },
            getSafeShellExecutionOptions: () => ({}),
            runInstallInTerminal: () => Promise.resolve(),
            getEnvironments: () => Promise.resolve(['default', 'prod']),
            updateStatusBar: () => { },
            activate: () => Promise.resolve(),
            deactivate: () => Promise.resolve()
        };

        const offlineManager = new OfflineManager(mockEnvManager);

        // Setup User Input: Select a script file
        showOpenDialogResult = [{ fsPath: '/mock/downloaded/env-installer.sh' }];

        await offlineManager.loadOfflineEnvironment();

        // Verification
        const reloadCall = commandCalls.find(c => c === 'workbench.action.reloadWindow');
        assert.ok(reloadCall, 'Should auto-reload window when config is enabled');
    });

});

import * as assert from 'assert';
import * as path from 'path';


const proxyquire = require('proxyquire').noCallThru();

suite('Micromamba Conflict Test Suite', () => {

    let commandCalls: string[] = [];
    let mockConfig: { [key: string]: any } = {};

    // Mock VS Code
    const vscodeMock = {
        ExtensionContext: class { },
        Uri: { file: (f: string) => ({ fsPath: f, scheme: 'file', toString: () => f }) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
            getWorkspaceFolder: (uri: any) => ({ uri: { fsPath: '/mock/workspace' }, index: 0, name: 'Workspace' }),
            getConfiguration: () => ({
                get: (key: string, def?: any) => {
                    if (key in mockConfig) { return mockConfig[key]; }
                    return def;
                },
                update: () => Promise.resolve()
            })
        },
        commands: {
            getCommands: (filter: boolean) => Promise.resolve([
                'micromamba.deactivate', // Simulate this command existing
                'other.command'
            ]),
            executeCommand: (cmd: string, ...args: any[]) => {
                commandCalls.push(cmd);
                return Promise.resolve();
            }
        },
        window: {
            showInformationMessage: () => Promise.resolve(),
            showErrorMessage: (msg: string) => console.error(msg),
            createStatusBarItem: () => ({
                show: () => { },
                hide: () => { },
                dispose: () => { },
                text: '',
                command: '',
                tooltip: ''
            }),
            createTerminal: (name: string) => ({
                show: () => { },
                sendText: () => { },
                dispose: () => { },
                exitStatus: { code: 0 }
            }),
            withProgress: async (opts: any, task: any) => await task({ report: () => { } }),
            showQuickPick: (items: any) => Promise.resolve(items && items.length > 0 ? items[0] : undefined)
        },
        StatusBarAlignment: { Left: 1, Right: 2 },
        // Minimal mocks effectively needed for EnvironmentManager instantiation
        ProgressLocation: { Notification: 15 }
    };

    // Mock FS
    const fsMock = {
        existsSync: (p: string) => true, // Start with everything existing
        promises: {
            readFile: (p: string) => Promise.resolve(''),
            writeFile: (p: string, c: string) => Promise.resolve()
        }
    };

    // Mock global child_process
    const cpMock = {
        exec: (cmd: string, opts: any, cb: any) => {
            // Mock pixi info --json
            if (cmd.includes('info --json')) {
                cb(null, JSON.stringify({ environments_info: [{ name: 'default', prefix: '/mock/prefix' }] }), '');
            } else if (cmd.includes('pixi shell-hook')) {
                cb(null, 'export FOO=BAR', '');
            } else {
                cb(null, '', '');
            }
        }
    };

    // Import EnvironmentManager with mocks
    const EnvironmentManager = proxyquire('../../environment', {
        'vscode': vscodeMock,
        'fs': fsMock,
        'child_process': cpMock,
        'path': path
    }).EnvironmentManager;

    let envManager: any;
    let context: any;
    let mockPixiManager: any;

    let originalCondPrefix: string | undefined;

    setup(() => {
        originalCondPrefix = process.env.CONDA_PREFIX;
        commandCalls = [];
        mockConfig = {};
        context = {
            subscriptions: [],
            workspaceState: {
                get: () => undefined,
                update: () => Promise.resolve()
            },
            globalState: {
                get: () => undefined,
                update: () => Promise.resolve()
            },
            environmentVariableCollection: {
                replace: () => { },
                clear: () => { }
            },
            extensionPath: '/mock/extension/path'
        };
        mockPixiManager = {
            isPixiInstalled: () => Promise.resolve(true),
            getPixiPath: () => Promise.resolve('/usr/bin/pixi')
        };
        const mockExec = async (cmd: string) => {
            if (cmd.includes('info --json')) {
                return { stdout: JSON.stringify({ environments_info: [{ name: 'default', prefix: '/mock/prefix' }] }), stderr: '' };
            } else if (cmd.includes('shell-hook')) {
                return { stdout: 'export FOO=BAR', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        };
        envManager = new EnvironmentManager(mockPixiManager, context, undefined, mockExec);
    });

    teardown(() => {
        process.env.CONDA_PREFIX = originalCondPrefix;
        delete process.env.CONDA_DEFAULT_ENV;
        delete process.env.PIXI_IN_SHELL;
    });

    test('Activate attempts to deactivate micromamba if conflicting command exists', async () => {
        // Run activate. Expect it to find a known command in getCommands (mocked) and execute it.
        process.env.CONDA_PREFIX = '/mock/env';
        await envManager.activate();

        // Check if deactivate was called
        const deactivateCalled = commandCalls.includes('micromamba.deactivate');
        assert.ok(deactivateCalled, 'Should have called micromamba.deactivate');
    });

    test('Activate does NOT deactivate if no conflicting command is found', async () => {
        // Override getCommands to NOT return the known candidates
        vscodeMock.commands.getCommands = (filter: boolean) => Promise.resolve(['other.command']);

        // Reset calls
        commandCalls = [];

        await envManager.activate();

        const deactivateCalled = commandCalls.includes('micromamba.deactivate');
        assert.ok(!deactivateCalled, 'Should not have called deactivate');
    });

    test('Activate finds alternative command names', async () => {
        // Override getCommands to return an alternative
        vscodeMock.commands.getCommands = (filter: boolean) => Promise.resolve(['corker.micromamba.deactivate.environment']);

        // Reset calls
        commandCalls = [];

        // Simulate active micromamba env
        process.env.CONDA_PREFIX = '/mock/env';
        await envManager.activate();

        const deactivateCalled = commandCalls.includes('corker.micromamba.deactivate.environment');
        assert.ok(deactivateCalled, 'Should have called corker.micromamba.deactivate.environment');
    });
    test('Activate does NOT deactivate if command exists but no environment active', async () => {
        // Command exists (default mock behavior: micromamba.deactivate is in the list)

        // Ensure no active env vars
        delete process.env.CONDA_PREFIX;
        // delete process.env.MAMBA_EXE; // No longer checking this, checking just prefix is enough

        commandCalls = [];
        await envManager.activate();

        const deactivateCalled = commandCalls.includes('micromamba.deactivate');
        assert.ok(!deactivateCalled, 'Should NOT have called deactivate when no environment is active');
    });

    test('Activate does NOT deactivate if environment is base', async () => {
        // Command exists
        vscodeMock.commands.getCommands = (filter: boolean) => Promise.resolve(['micromamba.deactivate']);

        // Simulate base env active
        process.env.CONDA_PREFIX = '/home/user/conda/base';
        process.env.CONDA_DEFAULT_ENV = 'base';

        commandCalls = [];
        await envManager.activate();

        const deactivateCalled = commandCalls.includes('micromamba.deactivate');
        assert.ok(!deactivateCalled, 'Should NOT have called deactivate for base environment');
    });

    test('Activate does NOT deactivate if environment IS Pixi (path contains .pixi/envs)', async () => {
        // Command exists
        vscodeMock.commands.getCommands = (filter: boolean) => Promise.resolve(['micromamba.deactivate']);

        // Simulate a Pixi environment (which sets CONDA_PREFIX for compatibility)
        process.env.CONDA_PREFIX = '/home/user/project/.pixi/envs/default';
        process.env.CONDA_DEFAULT_ENV = 'default';
        // process.env.PIXI_IN_SHELL = '1'; // Removed this specific check in favor of path check

        commandCalls = [];
        await envManager.activate();

        const deactivateCalled = commandCalls.includes('micromamba.deactivate');
        assert.ok(!deactivateCalled, 'Should NOT have called deactivate if path contains .pixi/envs');
    });

    test('Activate DOES deactivate if nested Micromamba env on top of Pixi', async () => {
        // Command exists
        vscodeMock.commands.getCommands = (filter: boolean) => Promise.resolve(['micromamba.deactivate']);

        // Simulate nested scenario:
        // PIXI_IN_SHELL might be set, but CONDA_PREFIX points to a micromamba env (no .pixi/envs)
        process.env.PIXI_IN_SHELL = '1';
        process.env.CONDA_PREFIX = '/home/user/.micromamba/envs/conflict';
        process.env.CONDA_DEFAULT_ENV = 'conflict';

        commandCalls = [];
        await envManager.activate();

        const deactivateCalled = commandCalls.includes('micromamba.deactivate');
        assert.ok(deactivateCalled, 'Should HAVE called deactivate for nested micromamba env');
    });

    test('Activate DOES deactivate if CONDA_PREFIX masked but PATH contains micromamba/envs/', async () => {
        // Command exists
        vscodeMock.commands.getCommands = (filter: boolean) => Promise.resolve(['micromamba.deactivate']);

        // Simulate masked ID: prefix points to Pixi, but PATH has dirty micromamba
        process.env.CONDA_PREFIX = '/home/user/project/.pixi/envs/default';
        process.env.CONDA_DEFAULT_ENV = 'default';
        // Dirty PATH
        process.env.PATH = '/home/user/.micromamba/envs/dirty/bin:/usr/bin';

        commandCalls = [];
        await envManager.activate();

        const deactivateCalled = commandCalls.includes('micromamba.deactivate');
        assert.ok(deactivateCalled, 'Should HAVE called deactivate due to PATH detection');
    });
});

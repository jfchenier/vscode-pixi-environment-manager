
import * as assert from 'assert';
// import { EnvironmentManager } from '../../environment'; // We will load via proxyquire



const proxyquire = require('proxyquire').noCallThru();

suite('Command Visibility Context Test Suite', () => {

    let recordedCommands: { command: string, key: string, value: any }[] = [];
    let mockFs: { [path: string]: boolean } = {};

    // Mock VS Code
    const vscodeMock = {
        ExtensionContext: class { },
        OutputChannel: class { },
        Uri: { file: (f: string) => ({ fsPath: f, scheme: 'file' }) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
            getConfiguration: () => ({
                get: (key: string, def?: any) => def,
                update: () => Promise.resolve()
            })
        },
        commands: {
            executeCommand: (cmd: string, key: string, value: any) => {
                if (cmd === 'setContext') {
                    recordedCommands.push({ command: cmd, key, value });
                }
                return Promise.resolve();
            }
        },
        ProgressLocation: {
            Window: 10,
            Notification: 15
        },
        window: {
            showInformationMessage: () => Promise.resolve(),
            showErrorMessage: () => Promise.resolve(),
            showWarningMessage: () => Promise.resolve(),
            withProgress: (opts: any, task: any) => task({ report: () => { } }),
            createTerminal: () => ({ show: () => { }, sendText: () => { }, dispose: () => { } }),
            createStatusBarItem: () => ({
                show: () => { },
                hide: () => { },
                dispose: () => { },
                text: '',
                command: '',
                tooltip: ''
            })
        },
        StatusBarAlignment: { Left: 1, Right: 2 }
    };

    // Mock FS
    const fsMock = {
        existsSync: (p: string) => {
            // Check if any key in mockFs is a suffix of p (to handle absolute paths)
            // or identical
            if (mockFs[p]) { return true; }
            for (const key in mockFs) {
                if (p.endsWith(key) && mockFs[key]) { return true; }
            }
            return false;
        },
        promises: {
            rm: () => Promise.resolve(),
            writeFile: () => Promise.resolve()
        }
    };

    // Load EnvironmentManager with mocks
    const { EnvironmentManager } = proxyquire('../../environment', {
        'vscode': vscodeMock,
        'fs': fsMock
    });

    // Mock PixiManager
    class MockPixiManager {
        public async isPixiInstalled() { return true; }
        public getPixiPath() { return '/mock/pixi'; }
    }

    setup(() => {
        recordedCommands = [];
        mockFs = {};
    });

    test('Initial Context: No .pixi folder -> pixi.hasPixiDirectory = false', () => {
        new EnvironmentManager(new MockPixiManager(), { subscriptions: [], workspaceState: { get: () => undefined, update: () => Promise.resolve() } }, undefined);

        const setContextCall = recordedCommands.find(c => c.key === 'pixi.hasPixiDirectory');
        assert.ok(setContextCall, 'Should update pixi.hasPixiDirectory context');
        assert.strictEqual(setContextCall!.value, false, 'Should be false when folder is missing');
    });

    test('Initial Context: With .pixi folder -> pixi.hasPixiDirectory = true', () => {
        mockFs['.pixi'] = true; // /mock/workspace/.pixi
        new EnvironmentManager(new MockPixiManager(), {
            subscriptions: [],
            workspaceState: { get: () => undefined, update: () => Promise.resolve() }
        }, undefined);

        const setContextCall = recordedCommands.find(c => c.key === 'pixi.hasPixiDirectory');
        assert.ok(setContextCall, 'Should update pixi.hasPixiDirectory context');
        assert.strictEqual(setContextCall!.value, true, 'Should be true when folder exists');
    });

    test('Activate Environment -> pixi.isEnvironmentActive = true', async () => {
        mockFs['.pixi'] = true;
        // Mock context for environment variable collection
        const mockContext = {
            environmentVariableCollection: { clear: () => { }, replace: () => { } },
            workspaceState: { get: () => undefined, update: () => Promise.resolve() },
            subscriptions: []
        };

        const envManager = new EnvironmentManager(new MockPixiManager(), mockContext, undefined);
        // Reset commands recorded during init
        recordedCommands = [];

        // We mock _exec to succeed
        envManager._exec = async () => ({
            stdout: JSON.stringify({ environment_variables: { FOO: 'BAR' } }),
            stderr: ''
        });

        // Mock getEnvironments to return something so activate() works
        envManager.getEnvironments = async () => ['default'];

        await envManager.activate(true); // Silent activate default

        const activeCall = recordedCommands.find(c => c.key === 'pixi.isEnvironmentActive');
        assert.ok(activeCall, 'Should set pixi.isEnvironmentActive');
        assert.strictEqual(activeCall!.value, true, 'Should be active after activation');
    });

    test('Deactivate Environment -> pixi.isEnvironmentActive = false', async () => {
        const mockContext = {
            environmentVariableCollection: { clear: () => { }, replace: () => { } },
            workspaceState: { get: () => 'default', update: () => Promise.resolve() },
            subscriptions: []
        };

        const envManager = new EnvironmentManager(new MockPixiManager(), mockContext, undefined);
        recordedCommands = [];

        await envManager.deactivate(true);

        const activeCall = recordedCommands.find(c => c.key === 'pixi.isEnvironmentActive');
        assert.ok(activeCall, 'Should set pixi.isEnvironmentActive');
        assert.strictEqual(activeCall!.value, false, 'Should be inactive after deactivation');
    });

    test('Pixi isInstalled Context Check', async () => {
        // Mock pixiManager to return false, then true
        class MutablePixiManager extends MockPixiManager {
            public installed = false;
            public override async isPixiInstalled() { return this.installed; }
        }
        const px = new MutablePixiManager();
        const envManager = new EnvironmentManager(px, {
            subscriptions: [],
            workspaceState: { get: () => undefined, update: () => Promise.resolve() }
        }, undefined);

        // Init: installed = false
        // We need to wait for the async check in constructor to settle.
        await new Promise(r => setTimeout(r, 10)); // Yield

        let installCall = recordedCommands.find(c => c.key === 'pixi.isPixiInstalled');
        assert.ok(installCall, 'Should set pixi.isPixiInstalled');
        assert.strictEqual(installCall?.value, false, 'Should be false initially');

        recordedCommands = [];
        px.installed = true;
        // Trigger update
        // updatePixiContext is private. We can trigger it via createEnvironment or similar, BUT
        // createEnvironment uses UI.
        // We can access private method by cast to any (in test)
        (envManager as any).updatePixiContext();

        await new Promise(r => setTimeout(r, 10)); // Yield

        installCall = recordedCommands.find(c => c.key === 'pixi.isPixiInstalled');
        assert.ok(installCall, 'Should set pixi.isPixiInstalled');
        assert.strictEqual(installCall?.value, true, 'Should be true after install');
    });
});

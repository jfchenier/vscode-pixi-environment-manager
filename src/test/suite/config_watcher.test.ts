import * as assert from 'assert';
const proxyquire = require('proxyquire').noCallThru();

suite('Config Watcher Test Suite', () => {

    let mockConfig: { [key: string]: any } = {};
    let configUpdates: { key: string, value: any }[] = [];

    // Watcher Mocks
    let watcherCallback: any;
    const mockWatcher = {
        onDidChange: (cb: any) => { watcherCallback = cb; return { dispose: () => { } }; },
        onDidCreate: (cb: any) => { watcherCallback = cb; return { dispose: () => { } }; },
        onDidDelete: (cb: any) => { watcherCallback = cb; return { dispose: () => { } }; },
        dispose: () => { }
    };

    const vscodeMock = {
        workspace: {
            createFileSystemWatcher: () => mockWatcher,
            onDidSaveTextDocument: () => ({ dispose: () => { } }),
            getConfiguration: () => ({
                get: (key: string) => mockConfig[key],
                update: (key: string, value: any) => {
                    configUpdates.push({ key, value });
                    mockConfig[key] = value;
                    return Promise.resolve();
                }
            }),
            onDidChangeConfiguration: () => ({ dispose: () => { } }),
        },
        window: {
            createOutputChannel: () => ({ appendLine: () => { } }),
            showInformationMessage: async () => undefined,
            withProgress: (_opts: any, task: any) => task()
        },
        commands: {
            registerCommand: () => ({ dispose: () => { } }),
            executeCommand: () => Promise.resolve()
        },
        ConfigurationTarget: { Global: 1 },
        ExtensionContext: {}
    };

    // Mock EnvironmentManager/PixiManager
    class MockEnvManager {
        public checkCalled = false;
        async activate() { }
        async autoActivate() { }
        async checkAndPromptForUpdate(silent: boolean = false, changedFile?: string) { this.checkCalled = true; return false; }
        getCurrentEnvName() { return undefined; }
    }
    class MockPixiManager {
        checkAndPromptSystemPixi() { }
        async checkUpdate() { }
    }

    const mockUri: any = { fsPath: '/mock/pixi.toml' };

    test('Watcher triggers checkAndPromptForUpdate on config change', async () => {
        let envManagerInstance: MockEnvManager;
        const { activate } = proxyquire('../../extension', {
            'vscode': vscodeMock,
            './environment': {
                EnvironmentManager: class extends MockEnvManager {
                    constructor() {
                        super();
                        // eslint-disable-next-line @typescript-eslint/no-this-alias
                        envManagerInstance = this;
                    }
                }
            },
            './pixi': { PixiManager: MockPixiManager }
        });

        const context: any = { subscriptions: [] };
        // Clean references
        watcherCallback = undefined;
        await activate(context);

        // Reset check status from startup (if any? startup doesn't trigger anymore, but checkCalled defaults to false)
        envManagerInstance!.checkCalled = false;

        assert.ok(watcherCallback, 'Watcher registered');
        watcherCallback!(mockUri);

        // Wait for debounce
        await new Promise(r => setTimeout(r, 1100));

        assert.ok(envManagerInstance!.checkCalled, 'Should call checkAndPromptForUpdate after debounce');
    });
});


import * as assert from 'assert';

const proxyquire = require('proxyquire').noCallThru();

suite('System Pixi Support Test Suite', () => {

    let mockConfig: { [key: string]: any } = {};
    let mockGlobalState: { [key: string]: any } = {};
    let execCalls: string[] = [];
    let showMessageCalls: string[] = [];
    let configUpdates: { key: string, value: any }[] = [];
    let stateUpdates: { key: string, value: any }[] = [];

    const vscodeMock = {
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
            getConfiguration: () => ({
                get: (key: string, def?: any) => {
                    const val = mockConfig[key] !== undefined ? mockConfig[key] : def;
                    console.log(`[TEST] config.get('${key}') -> ${val} (def: ${def})`);
                    console.log(`[TEST] mockConfig: ${JSON.stringify(mockConfig)}`);
                    return val;
                },
                update: (key: string, value: any) => {
                    configUpdates.push({ key, value });
                    mockConfig[key] = value;
                    return Promise.resolve();
                },
                inspect: (key: string) => undefined
            })
        },
        window: {
            showInformationMessage: async (msg: string, ...items: string[]) => {
                showMessageCalls.push(msg);
                // Simulate user selecting "Yes" if msg contains "system"
                if (msg.includes('system installation')) { return 'Yes' as any; }
                if (msg.includes('Reload window')) { return 'Reload' as any; }
                return undefined;
            },
            createOutputChannel: () => ({ appendLine: () => { } }) as any,
            ProgressLocation: { Notification: 15 }
        },
        commands: {
            executeCommand: (cmd: string) => {
                execCalls.push(`vscode.executeCommand:${cmd}`);
                return Promise.resolve();
            }
        },
        ConfigurationTarget: { Global: 1 },
        Uri: { file: (f: string) => ({ fsPath: f }) }
    };

    const fsMock = {
        promises: {
            access: () => Promise.resolve(), // Bundled always exists in this mock unless checking system logic
        },
        constants: { X_OK: 1 }
    };

    const cpMock = {
        exec: (cmd: string, cb: any) => {
            execCalls.push(cmd);
            if (cmd.includes('--version')) {
                cb(null, 'pixi 0.1.0', '');
            } else {
                cb(null, '', '');
            }
        }
    };

    const { PixiManager } = proxyquire('../../pixi', {
        'vscode': vscodeMock,
        'fs': fsMock,
        'child_process': cpMock,
        'path': require('path') // Use real path
    });

    setup(() => {
        // Manually clear properties to handle closure capture issues if any
        for (const k in mockConfig) delete mockConfig[k];
        for (const k in mockGlobalState) delete mockGlobalState[k];
        execCalls.length = 0;
        showMessageCalls.length = 0;
        configUpdates.length = 0;
        stateUpdates.length = 0;
    });

    // ... (existing getPixiPath tests) ...

    test('checkAndPromptSystemPixi prompts if system exists and not ignored', async () => {
        const pm = new PixiManager();
        const contextMock = {
            globalState: {
                get: (key: string) => mockGlobalState[key],
                update: (key: string, value: any) => {
                    stateUpdates.push({ key, value });
                    mockGlobalState[key] = value;
                    return Promise.resolve();
                }
            }
        };

        await pm.checkAndPromptSystemPixi(contextMock);

        // Check if exec called for version
        const versionCheck = execCalls.some(c => c.includes('--version'));
        assert.ok(versionCheck, 'Should check system version');

        // Check if prompt shown
        const promptShown = showMessageCalls.some(s => s.includes('system installation'));
        assert.ok(promptShown, 'Should show prompt');

        // Check if config updated (mock returns Yes)
        const updated = configUpdates.find(u => u.key === 'useSystemPixi');
        assert.strictEqual(updated?.value, true, 'Should update config to true');
    });

    test('checkAndPromptSystemPixi DOES NOT prompt if explicitly set to false', async () => {
        // Imitate inspect returning a global value
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key: string) => mockConfig[key],
            update: () => Promise.resolve(),
            inspect: (key: string) => {
                if (key === 'useSystemPixi') {
                    return { globalValue: false }; // Explicitly set to false
                }
                return undefined;
            }
        }) as any;

        const pm = new PixiManager();
        const contextMock = { globalState: { get: () => undefined } } as any;

        await pm.checkAndPromptSystemPixi(contextMock);

        const promptShown = showMessageCalls.some(s => s.includes('system installation'));
        assert.ok(!promptShown, 'Should NOT show prompt if explicitly false');
    });

    test('checkAndPromptSystemPixi sets config to false when user says No', async () => {
        // Mock returning "No"
        vscodeMock.window.showInformationMessage = async (msg: string, ...items: string[]) => {
            if (msg.includes('system installation')) { return 'No (Use Bundled Executable)' as any; }
            return undefined;
        };

        // Reset config mock to default
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key: string) => mockConfig[key],
            update: (key: string, value: any) => {
                configUpdates.push({ key, value });
                return Promise.resolve();
            },
            inspect: (key: string) => ({}) // No explicit values set
        }) as any;

        const pm = new PixiManager();
        const contextMock = { globalState: { get: () => undefined } } as any;

        await pm.checkAndPromptSystemPixi(contextMock);

        const updated = configUpdates.find(u => u.key === 'useSystemPixi');
        assert.strictEqual(updated?.value, false, 'Should update config to false');
    });

    test('checkAndPromptSystemPixi DOES NOT prompt if already enabled', async () => {
        mockConfig['useSystemPixi'] = true;
        const pm = new PixiManager();
        const contextMock = {
            globalState: {
                get: (key: string) => mockGlobalState[key],
                update: () => Promise.resolve()
            }
        };

        await pm.checkAndPromptSystemPixi(contextMock);

        const promptShown = showMessageCalls.some(s => s.includes('system installation'));
        assert.ok(!promptShown, 'Should NOT show prompt if already enabled');
    });

    test('checkAndPromptSystemPixi asks for reload if auto-reload disabled', async () => {
        mockConfig['autoReload'] = false;

        const pm = new PixiManager();
        let reloadCommandCalled = false;
        let reloadPromptShown = false;

        // Mock window to capture second prompt
        const originalShowInfo = vscodeMock.window.showInformationMessage;
        vscodeMock.window.showInformationMessage = async (msg: string, ...items: string[]) => {
            if (msg.includes('system installation')) { return 'Yes' as any; }
            if (msg.includes('Reload window')) {
                reloadPromptShown = true;
                return 'Reload' as any;
            }
            return undefined;
        };

        const contextMock = {
            globalState: {
                get: (key: string) => mockGlobalState[key],
                update: () => Promise.resolve()
            }
        };

        await pm.checkAndPromptSystemPixi(contextMock);

        assert.ok(reloadPromptShown, 'Should show reload prompt');
        const reloadTriggered = execCalls.some(c => c.includes('workbench.action.reloadWindow'));
        assert.ok(reloadTriggered, 'Should reload after confirmation');

        // Restore
        vscodeMock.window.showInformationMessage = originalShowInfo;
    });
});

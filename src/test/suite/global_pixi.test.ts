
import * as assert from 'assert';
 
const proxyquire = require('proxyquire').noCallThru();

suite('Global Pixi Support Test Suite', () => {

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
                    return mockConfig[key] !== undefined ? mockConfig[key] : def;
                },
                update: (key: string, value: any) => {
                    configUpdates.push({ key, value });
                    mockConfig[key] = value;
                    return Promise.resolve();
                }
            })
        },
        window: {
            showInformationMessage: async (msg: string, ...items: string[]) => {
                showMessageCalls.push(msg);
                // Simulate user selecting "Yes" if msg contains "global"
                if (msg.includes('global installation')) {return 'Yes' as any;}
                return undefined;
            },
            createOutputChannel: () => ({ appendLine: () => { } }) as any,
            ProgressLocation: { Notification: 15 }
        },
        commands: {
            executeCommand: (cmd: string) => Promise.resolve()
        },
        ConfigurationTarget: { Global: 1 },
        Uri: { file: (f: string) => ({ fsPath: f }) }
    };

    const fsMock = {
        promises: {
            access: () => Promise.resolve(), // Local always exists in this mock unless checking global logic
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
        mockConfig = {};
        mockGlobalState = {};
        execCalls = [];
        showMessageCalls = [];
        configUpdates = [];
        stateUpdates = [];
    });

    test('getPixiPath returns local path by default', () => {
        const pm = new PixiManager();
        const p = pm.getPixiPath();
        assert.ok(p?.includes('.pixi'), 'Should contain .pixi by default');
        // Ensure it looks like a full path, not just "pixi"
        assert.ok(p !== 'pixi' && p !== 'pixi.exe', 'Should not optionally return just the binary name');
        assert.ok(p?.startsWith('/') || p?.match(/^[a-zA-Z]:/), 'Should be absolute path');
    });

    test('getPixiPath returns global name if configured', () => {
        mockConfig['useGlobalPixi'] = true;
        const pm = new PixiManager();
        const path = pm.getPixiPath();
        if (process.platform === 'win32') {
            assert.strictEqual(path, 'pixi.exe');
        } else {
            assert.strictEqual(path, 'pixi');
        }
    });

    test('checkAndPromptGlobalPixi prompts if global exists and not ignored', async () => {
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

        await pm.checkAndPromptGlobalPixi(contextMock);

        // Check if exec called for version
        const versionCheck = execCalls.some(c => c.includes('--version'));
        assert.ok(versionCheck, 'Should check global version');

        // Check if prompt shown
        const promptShown = showMessageCalls.some(s => s.includes('global installation'));
        assert.ok(promptShown, 'Should show prompt');

        // Check if config updated (mock returns Yes)
        const updated = configUpdates.find(u => u.key === 'useGlobalPixi');
        assert.strictEqual(updated?.value, true, 'Should update config to true');
    });

    test('checkAndPromptGlobalPixi DOES NOT prompt if ignored', async () => {
        mockGlobalState['pixi.ignoreGlobalPixi'] = true;
        const pm = new PixiManager();
        const contextMock = {
            globalState: {
                get: (key: string) => mockGlobalState[key],
                update: () => Promise.resolve()
            }
        };

        await pm.checkAndPromptGlobalPixi(contextMock);

        const promptShown = showMessageCalls.some(s => s.includes('global installation'));
        assert.ok(!promptShown, 'Should NOT show prompt if ignored');
    });

    test('checkAndPromptGlobalPixi DOES NOT prompt if already enabled', async () => {
        mockConfig['useGlobalPixi'] = true;
        const pm = new PixiManager();
        const contextMock = {
            globalState: {
                get: (key: string) => mockGlobalState[key],
                update: () => Promise.resolve()
            }
        };

        await pm.checkAndPromptGlobalPixi(contextMock);

        const promptShown = showMessageCalls.some(s => s.includes('global installation'));
        assert.ok(!promptShown, 'Should NOT show prompt if already enabled');
    });

    test('checkAndPromptGlobalPixi triggers auto-reload if configured', async () => {
        mockConfig['autoReload'] = true;

        const pm = new PixiManager();
        let reloadCommandCalled = false;

        // Mock executeCommand to intercept reload
        vscodeMock.commands = {
            executeCommand: (cmd: string) => {
                if (cmd === 'workbench.action.reloadWindow') {
                    reloadCommandCalled = true;
                }
                return Promise.resolve();
            }
        } as any;

        const contextMock = {
            globalState: {
                get: (key: string) => mockGlobalState[key],
                update: () => Promise.resolve()
            }
        };

        await pm.checkAndPromptGlobalPixi(contextMock);

        assert.ok(reloadCommandCalled, 'Should verify auto-reload triggered');
    });

    test('checkAndPromptGlobalPixi asks for reload if auto-reload disabled', async () => {
        mockConfig['autoReload'] = false;

        const pm = new PixiManager();
        let reloadCommandCalled = false;
        let reloadPromptShown = false;

        // Mock window to capture second prompt
        const originalShowInfo = vscodeMock.window.showInformationMessage;
        vscodeMock.window.showInformationMessage = async (msg: string, ...items: string[]) => {
            if (msg.includes('global installation')) {return 'Yes';}
            if (msg.includes('Reload window')) {
                reloadPromptShown = true;
                return 'Reload';
            }
            return undefined;
        };

        vscodeMock.commands = {
            executeCommand: (cmd: string) => {
                if (cmd === 'workbench.action.reloadWindow') {
                    reloadCommandCalled = true;
                }
                return Promise.resolve();
            }
        } as any;

        const contextMock = {
            globalState: {
                get: (key: string) => mockGlobalState[key],
                update: () => Promise.resolve()
            }
        };

        await pm.checkAndPromptGlobalPixi(contextMock);

        assert.ok(reloadPromptShown, 'Should show reload prompt');
        assert.ok(reloadCommandCalled, 'Should reload after confirmation');

        // Restore
        vscodeMock.window.showInformationMessage = originalShowInfo;
    });
});

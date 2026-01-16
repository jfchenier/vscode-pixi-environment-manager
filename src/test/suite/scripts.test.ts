import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ScriptGenerator } from '../../features/scripts';

suite('Script Generation Test Suite', () => {
    let sandboxDir: string;

    setup(() => {
        sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixi-vscode-scripts-'));
    });

    teardown(() => {
        try {
            fs.rmSync(sandboxDir, { recursive: true, force: true });
        } catch { }
    });

    test('generateActivationScripts creates files', async () => {
        const outputChannel = vscode.window.createOutputChannel("Pixi Test");
        const scriptGen = new ScriptGenerator(outputChannel);

        const uri = vscode.Uri.file(sandboxDir);
        await scriptGen.generateActivationScripts(uri);

        const shPath = path.join(sandboxDir, 'activate.sh');
        assert.ok(fs.existsSync(shPath), 'activate.sh should exist');

        const batPath = path.join(sandboxDir, 'activate.bat');
        assert.ok(fs.existsSync(batPath), 'activate.bat should exist');

        // Check content
        const shContent = fs.readFileSync(shPath, 'utf8');
        assert.ok(shContent.includes('grep -v "^default$"'), 'sh script should filter default');
        assert.ok(shContent.includes('"$_COUNT" -eq "1"'), 'sh script should have auto-select logic');

        const batContent = fs.readFileSync(batPath, 'utf8');
        assert.ok(batContent.includes('if not "%%i"=="default"'), 'bat script should filter default');
        assert.ok(batContent.includes('if "%_COUNT%"=="1"'), 'bat script should have auto-select logic');
    });

    test('generateActivationScripts does not overwrite existing', async () => {
        const outputChannel = vscode.window.createOutputChannel("Pixi Test");
        const scriptGen = new ScriptGenerator(outputChannel);

        const uri = vscode.Uri.file(sandboxDir);
        const shPath = path.join(sandboxDir, 'activate.sh');

        fs.writeFileSync(shPath, '# custom content');

        await scriptGen.generateActivationScripts(uri);

        const content = fs.readFileSync(shPath, 'utf8');
        assert.strictEqual(content, '# custom content', 'Should preserve existing content');
    });
});

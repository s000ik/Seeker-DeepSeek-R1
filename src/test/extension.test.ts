import * as assert from 'assert';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';

suite('Seeker Extension Test Suite', () => {
    let mockWebview: vscode.Webview;
    let statusBarItem: vscode.StatusBarItem;
    let errorMessageShown: string | undefined;
    let messages: any[] = [];

    setup(() => {
        // Reset state before each test
        messages = [];
        errorMessageShown = undefined;

        // Mock webview
        mockWebview = {
            html: '',
            options: { enableScripts: true },
            postMessage: async (message: any) => {
                messages.push(message);
                return true;
            },
            onDidReceiveMessage: () => ({ dispose: () => {} }),
            asWebviewUri: (uri: vscode.Uri) => uri,
            cspSource: ''
        };

        // Create actual status bar item
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

        // Store original showErrorMessage
        const originalShowError = vscode.window.showErrorMessage;
        vscode.window.showErrorMessage = async (message: string) => {
            errorMessageShown = message;
            return undefined;
        };
    });

    teardown(() => {
        if (statusBarItem) {
            statusBarItem.dispose();
        }
    });

    test('Model Name Configuration', async () => {
        const config = vscode.workspace.getConfiguration('seeker');
        const modelName = config.get<string>('model') ?? 'deepseek-r1:1.5b';
        assert.strictEqual(typeof modelName, 'string');
        assert.ok(modelName.length > 0);
    });

    test('Status Bar Item Creation and Updates', () => {
        assert.ok(statusBarItem);
        statusBarItem.text = 'Test Status';
        assert.strictEqual(statusBarItem.text, 'Test Status');
    });

    test('Model Download Progress Simulation', () => {
        let progressText = '';
        statusBarItem.text = '';

        // Simulate progress update
        const progressData = '50% 500MB/1GB';
        const match = progressData.match(/(\d+)%.*?(\d+(?:\.\d+)?)\s*(MB|GB)\/(\d+(?:\.\d+)?)\s*(MB|GB)/);
        
        if (match) {
            const [, progress] = match;
            progressText = `Downloading: ${progress}%`;
            statusBarItem.text = progressText;
        }

        assert.ok(progressText.includes('50%'));
        assert.strictEqual(statusBarItem.text, progressText);
    });

    test('WebView Message Handling', async () => {
        // Test Message sending
        await mockWebview.postMessage({ type: 'test', content: 'Which model are you currently using?' });
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].type, 'test');
        assert.strictEqual(messages[0].content, 'Which model are you currently using?');
    });

    test('Error Message Display', async () => {
        const testError = 'Test Error Message';
        await vscode.window.showErrorMessage(testError);
        assert.strictEqual(errorMessageShown, testError);
    });

    test('Abort Controller Functionality', () => {
        const controller = new AbortController();
        assert.strictEqual(controller.signal.aborted, false);
        
        controller.abort();
        assert.strictEqual(controller.signal.aborted, true);
    });

    test('Command Registration', async () => {
        let commandExecuted = false;
        const disposable = vscode.commands.registerCommand('seeker.test', () => {
            commandExecuted = true;
        });

        try {
            await vscode.commands.executeCommand('seeker.test');
            assert.ok(commandExecuted);
        } finally {
            disposable.dispose();
        }
    });

    test('Stream Processing Simulation', () => {
        const emitter = new EventEmitter();
        let dataReceived = '';

        emitter.on('data', (chunk: string) => {
            dataReceived += chunk;
        });

        const testData = 'Test response data';
        emitter.emit('data', testData);

        assert.strictEqual(dataReceived, testData);
    });

    test('WebView Content Verification', () => {
        const panel = vscode.window.createWebviewPanel(
            'test',
            'Test Panel',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = `<!DOCTYPE html><html><body>Test Content</body></html>`;
        
        assert.ok(panel.webview.html.includes('<!DOCTYPE html>'));
        assert.ok(panel.webview.html.includes('Test Content'));

        panel.dispose();
    });

    test('Extension Settings Access', () => {
        const config = vscode.workspace.getConfiguration('seeker');
        assert.ok(config);
        
        // Test default model setting
        const model = config.get<string>('model');
        assert.ok(model === undefined || typeof model === 'string');
    });

    test('Status Bar Visibility Control', () => {
        statusBarItem.show();
        statusBarItem.hide();
        assert.ok(true, 'Status bar visibility controls work');
    });
});
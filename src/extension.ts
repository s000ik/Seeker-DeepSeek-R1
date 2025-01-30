import * as vscode from 'vscode';
import axios from 'axios';
import { exec } from 'child_process';

let abortController: AbortController | null = null;
let cachedModelName: string | undefined;
let lastKnownCustomModel: string | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
const OLLAMA_API_URL = 'http://localhost:11434/api/generate';


async function getModelName(): Promise<string> {
    const config = vscode.workspace.getConfiguration('seeker');
    const currentModel = config.get('model') as string;
    
    if (currentModel === 'custom') {
        const customModel = config.get('lastCustomModel') as string;
        
        // Clear cache if custom model has changed
        if (lastKnownCustomModel !== customModel) {
            console.log('Custom model changed:', { from: lastKnownCustomModel, to: customModel });
            cachedModelName = undefined;
            lastKnownCustomModel = customModel;
        }
        
        if (customModel) {
            cachedModelName = customModel;
            return customModel;
        }
        
        // If no custom model is set, use default
        cachedModelName = 'deepseek-r1:1.5b';
        return cachedModelName;
    }
    
    // Clear cache if switching from custom to preset model
    if (lastKnownCustomModel) {
        console.log('Switching from custom to preset model');
        cachedModelName = undefined;
        lastKnownCustomModel = undefined;
    }
    
    cachedModelName = currentModel || 'deepseek-r1:1.5b';
    return cachedModelName;
}

function createStatusBarItem() {
    if (statusBarItem) {
        return statusBarItem;
    }
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusBarItem.text = "$(sync~spin) Seeker is running...";
    return statusBarItem;
}

async function startOllama(): Promise<void> {
    try {
        await axios.get('http://localhost:11434/api/tags');
        const modelName = await getModelName();
        console.log('Selected model:', modelName);

        try {
            const testResponse = await axios.post(OLLAMA_API_URL, {
                model: modelName,
                prompt: "test",
                stream: false
            });
            console.log('Model test successful:', testResponse.status);
        } catch (error: any) {
            console.log('Model test error:', {
                message: error.message,
                status: error.response?.status,
                data: error.response?.data
            });

            // Handle both 404 and 400 status codes for model download
            if (error.response?.status === 404 || error.response?.status === 400 || 
                (error.message && error.message.includes('model not found'))) {
                
                const statusBar = createStatusBarItem();
                statusBar.text = "$(sync~spin) Initializing download...";
                statusBar.show();

                console.log(`Starting download for model: ${modelName}`);
                const child = exec(`ollama pull ${modelName}`);

                // Handle progress updates through stderr
                child.stderr?.on('data', (data: string) => {
                    const output = data.toString();
                    console.log('Raw stderr:', output);
                    
                    // Match progress pattern including both MB and GB
                    const progressMatch = output.match(/(\d+)%.*?(\d+(?:\.\d+)?)\s*(MB|GB)\/(\d+(?:\.\d+)?)\s*(MB|GB)/);
                    if (progressMatch) {
                        const [, progress, downloaded, downloadedUnit, total, totalUnit] = progressMatch;
                        console.log('Progress match:', { progress, downloaded, downloadedUnit, total, totalUnit });
                        
                        // Convert to GB for display
                        const downloadedGB = downloadedUnit === 'GB' ? 
                            parseFloat(downloaded as any) : 
                            parseFloat(downloaded as any) / 1024;
                        const totalGB = totalUnit === 'GB' ? 
                            parseFloat(total as any) : 
                            parseFloat(total as any) / 1024;

                        if (statusBarItem) {
                            const newText = `$(sync~spin) Downloading ${modelName}: ${downloadedGB.toFixed(2)}GB / ${totalGB.toFixed(2)}GB (${progress}%)`;
                            console.log('Updating status bar:', newText);
                            statusBarItem.text = newText;
                        }
                    }
                });

                await new Promise<void>((resolve, reject) => {
                    child.on("close", (code) => {
                        console.log('Process closed with code:', code);
                        if (code === 0) {
                            if (statusBarItem) {
                                statusBarItem.text = "$(check) Model ready";
                                setTimeout(() => {
                                    if (statusBarItem) {
                                        statusBarItem.hide();
                                        statusBarItem.dispose();
                                        statusBarItem = undefined;
                                    }
                                }, 2000);
                            }
                            resolve();
                        } else {
                            reject(new Error(`Download failed with code ${code}. Model "${modelName}" may not exist.`));
                        }
                    });
                    child.on('error', (error: Error) => {
                        console.error('Process error:', error);
                        reject(error);
                    });
                });
            }
        }
    } catch (error: any) {
        console.error('Start Ollama error:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data
        });
        if (statusBarItem) {
            statusBarItem.hide();
            statusBarItem.dispose();
            statusBarItem = undefined;
        }
        if (error.response?.status === 400) {
            vscode.window.showErrorMessage(`Invalid model name "${await getModelName()}". Please check the model name and try again.`);
        } else {
            vscode.window.showErrorMessage('Failed to start Ollama. Please make sure it is installed and running.');
        }
        throw error;
    }
}

async function queryOllama(prompt: string, webview: vscode.Webview): Promise<string> {
    try {
        if (abortController) {
            abortController.abort();
        }

        const modelName = await getModelName();
        console.log('Querying with model:', modelName);
        abortController = new AbortController();

        const response = await axios.post(OLLAMA_API_URL, {
            model: modelName,
            prompt: prompt,
            stream: true
        }, {
                responseType: 'stream',
                signal: abortController.signal,
                validateStatus: (status) => status < 500
            }
        );

        if (response.status === 400) {
            throw new Error(`Invalid request for model "${modelName}". The model may not exist.`);
        }

        let fullResponse = '';
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                abortController = null;
                webview.postMessage({ type: "end" });
            };

            response.data.on('data', (chunk: Buffer) => {
                try {
                    const lines = chunk.toString().split("\n").filter(line => line.trim());
                    for (const line of lines) {
                        const parsed = JSON.parse(line);
                        if (parsed.response) {
                            fullResponse += parsed.response;
                            webview.postMessage({ type: "response", content: fullResponse });
                        }
                    }
                } catch (e) {
                    console.error('Error parsing chunk: ', e);
                }
            });

            response.data.on('end', () => {
                cleanup();
                resolve(fullResponse);
            });

            response.data.on('error', (error: Error) => {
                cleanup();
                error.name === "AbortError" ? resolve(fullResponse) : reject(error);
            });
        });
    } catch (error) {
        webview.postMessage({ type: "end" });
        console.error('Error querying Ollama:', error);
        throw error;
    }
}

// Create a new webview panel
async function createChatPanel() {
    const panel = vscode.window.createWebviewPanel(
        'seekerChat',
        'Seeker Chat',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    panel.webview.html = getWebviewContent();

    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.type) {
            case 'prompt':
                try {
                    await startOllama();
                    await queryOllama(message.content, panel.webview);
                } catch (error) {
                    vscode.window.showErrorMessage('Chat was stopped due to an error or user abort.');
                    panel.webview.postMessage({ type: 'end' });
                }
                break;
            case 'stop':
                if (abortController) {
                    abortController.abort();
                }
                break;
        }
    });
}

class SeekerViewProvider implements vscode.WebviewViewProvider {
    constructor(private readonly _extensionUri: vscode.Uri) {}

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = getWebviewContent();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'prompt':
                    try {
                        await startOllama();
                        await queryOllama(message.content, webviewView.webview);
                    } catch (error) {
                        vscode.window.showErrorMessage('Chat was stopped due to an error or user abort.');
                        webviewView.webview.postMessage({ type: 'end' });
                    }
                    break;
                case 'stop':
                    if (abortController) {
                        abortController.abort();
                    }
                    break;
            }
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new SeekerViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('seekerChat', provider)
    );

    let disposable = vscode.commands.registerCommand('seeker.query', createChatPanel);
    context.subscriptions.push(disposable);
}

export function deactivate() {
    cachedModelName = undefined; // Clear the cache
    if (abortController) {
        abortController.abort();
        abortController = null;
    }
    if (statusBarItem) {
        statusBarItem.hide();
        statusBarItem.dispose();
        statusBarItem = undefined;
    }

    // Kill any running Ollama processes
    return new Promise<void>((resolve) => {
        exec('taskkill /F /IM ollama.exe', (error) => {
            if (error) {
                console.log('Ollama process not found or already terminated');
            }
            resolve();
        });
    });
}

function getWebviewContent() {
    return /*html*/`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                html, body { 
                    margin: 0;
                    padding: 0;
                    height: 100vh;
                    overflow: hidden; /* Prevent outer scrolling */
                }
                body { 
                    padding: 20px; 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', 'Helvetica Neue', 
                                sans-serif;
                    max-width: 900px;
                    margin: 0 auto;
                    display: flex;
                    flex-direction: column;
                    height: calc(100vh - 40px); /* Account for padding */
                    line-height: 1.5;
                    box-sizing: border-box;
                }
                #chat-container {
                    flex: 1;
                    overflow-y: auto;
                    margin-bottom: 24px;
                    padding: 16px;
                    background: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 12px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                }
                .message {
                    padding: 12px 16px;
                    border-radius: 12px;
                    max-width: 85%;
                    font-size: 14px;
                    white-space: pre-wrap;
                    word-wrap: break-word;
                }
                .message-container {
                    display: flex;
                    flex-direction: column;
                    margin-bottom: 20px;
                    width: 100%;
                }
                .user-message {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    align-self: flex-end;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                }
                .assistant-message {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    color: var(--vscode-editor-foreground);
                    align-self: flex-start;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                }
                .assistant-message-container {
                    align-items: flex-start;
                }
                #input-container {
                    display: flex;
                    gap: 12px;
                    background: var(--vscode-editor-background);
                    border-radius: 12px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                    padding: 8px;
                }
                #prompt-input { 
                    flex: 1;
                    padding: 12px 16px;
                    border: 1px solid var(--vscode-input-border);
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border-radius: 8px;
                    resize: none;
                    height: 50px;
                    font-family: inherit;
                    font-size: 14px;
                    line-height: 1.5;
                    transition: border-color 0.2s ease;
                }
                #prompt-input:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                }
                #submit-button, #stop-button { 
                    padding: 12px 24px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 500;
                    transition: all 0.2s ease;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                #stop-button {
                    background: var(--vscode-errorForeground);
                    display: none;
                }
                #submit-button:hover, #stop-button:hover {
                    opacity: 0.9;
                    transform: translateY(-1px);
                }
                #stop-button:hover {
                    background: var(--vscode-testing-iconFailed);
                }
                #submit-button:active, #stop-button:active {
                    transform: translateY(1px);
                }
                .button-container {
                    display: flex;
                    gap: 8px;
                }
                .loading-dots {
                    display: inline-block;
                    width: 20px;
                    animation: dots 1.5s infinite;
                }
                .loading-dots::after {
                    content: '...';
                }
                @keyframes dots {
                    0%, 20% { content: '.'; }
                    40% { content: '..'; }
                    60% { content: '...'; }
                    80% { content: '....'; }
                }
                .processing {
                    opacity: 0.7;
                }
                /* Scrollbar styling */
                ::-webkit-scrollbar {
                    width: 4px;
                }
                ::-webkit-scrollbar-track {
                    background: transparent; /* Hidden track */
                    margin: 4px 0;
                    border-radius: 4px;
                }
                ::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-background);
                    border-radius: 4px;
                    transition: background 0.2s ease;
                }
                ::-webkit-scrollbar-thumb:hover {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                }
            </style>
        </head>
        <body>
            <div id="chat-container"></div>
            <div id="input-container">
                <textarea 
                    id="prompt-input" 
                    placeholder="Type your message here..."
                    rows="1"
                ></textarea>
                <div class="button-container">
                    <button id="submit-button">
                        <span>Send</span>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
                        </svg>
                    </button>
                    <button id="stop-button">
                        <span>Stop</span>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        </svg>
                    </button>
                </div>
            </div>
            <script>
                (function() {
                    const vscode = acquireVsCodeApi();
                    const chatContainer = document.getElementById('chat-container');
                    const promptInput = document.getElementById('prompt-input');
                    const submitButton = document.getElementById('submit-button');
                    const stopButton = document.getElementById('stop-button');
                    let isGenerating = false;

                    function getFormattedTime() {
                        return new Date().toLocaleTimeString([], { 
                            hour: '2-digit', 
                            minute: '2-digit' 
                        });
                    }

                    function toggleButtons(showStop) {
                        submitButton.style.display = showStop ? 'none' : 'flex';
                        stopButton.style.display = showStop ? 'flex' : 'none';
                        promptInput.disabled = showStop;
                        isGenerating = showStop;

                        if (!showStop) {
                            promptInput.focus();
                        }
                    }

                    function addMessage(content, isUser, isProcessing = false) {
                        const messageContainer = document.createElement('div');
                        messageContainer.className = isUser ? 'message-container user-message-container' : 'message-container assistant-message-container';
                        
                        const messageWrapper = document.createElement('div');
                        messageWrapper.style.cssText = 'display: flex; flex-direction: column; ' + 
                            (isUser ? 'align-items: flex-end' : 'align-items: flex-start');

                        const messageDiv = document.createElement('div');
                        messageDiv.className = isUser ? 'message user-message' : 'message assistant-message';
                        
                        if (isProcessing) {
                            messageDiv.innerHTML = 'Processing your request<span class="loading-dots"></span>';
                            messageDiv.classList.add('processing');
                        } else {
                            messageDiv.textContent = content;
                        }

                        const timeDiv = document.createElement('div');
                        timeDiv.className = 'message-time';
                        timeDiv.textContent = getFormattedTime();

                        messageWrapper.appendChild(messageDiv);
                        messageWrapper.appendChild(timeDiv);
                        messageContainer.appendChild(messageWrapper);
                        chatContainer.appendChild(messageContainer);
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }
                    
                    submitButton.addEventListener('click', () => {
                        const prompt = promptInput.value.trim();
                        if (prompt && !isGenerating) {
                            addMessage(prompt, true);
                            addMessage('', false, true); // Add processing message
                            vscode.postMessage({ type: 'prompt', content: prompt });
                            promptInput.value = '';
                            promptInput.style.height = '50px';
                            toggleButtons(true);
                        }
                    });

                    stopButton.addEventListener('click', () => {
                        vscode.postMessage({ type: 'stop' });
                        toggleButtons(false);
                    });

                    promptInput.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !isGenerating) {
                            e.preventDefault();
                            submitButton.click();
                        }
                    });

                    window.addEventListener('message', (event) => {
                        const message = event.data;
                        switch (message.type) {
                            case 'response':
                                const lastMessage = chatContainer.lastElementChild;
                                if (lastMessage && lastMessage.querySelector('.assistant-message')) {
                                    lastMessage.remove();
                                }
                                addMessage(message.content, false);
                                break;
                            case 'end':
                                toggleButtons(false);
                                break;
                            case 'error':
                                toggleButtons(false);
                                addMessage('Error: ' + message.content, false);
                                break;
                        }
                    });

                    promptInput.addEventListener('input', () => {
                        promptInput.style.height = '50px';
                        const newHeight = Math.min(promptInput.scrollHeight, 150);
                        promptInput.style.height = newHeight + 'px';
                    });

                    promptInput.focus();
                })();
            </script>
        </body>
        </html>
    `;
}

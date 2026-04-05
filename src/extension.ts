import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    const provider = new DreamDeployWebviewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            DreamDeployWebviewProvider.viewType,
            provider
        )
    );
}

interface ApiRequestMessage {
    type: 'apiRequest';
    id: string;
    apiKey: string;
    cmd: string;
    params?: Record<string, string>;
}

class DreamDeployWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'dreamdeploy.sidebarView';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'apiRequest':
                    this._handleApiRequest(webviewView.webview, data);
                    break;
                case 'deploy':
                    vscode.window.showInformationMessage(`Deploying to ${data.value}...`);
                    break;
                case 'log':
                    console.log(`[Webview Log]: ${data.value}`);
                    break;
            }
        });
    }

    /**
     * Invokes the Python dreamhostapi bridge script for a DreamHost API call
     * requested by the webview, then posts the result back.
     *
     * Tries `python3` first, then falls back to `python` on systems where only
     * the un-versioned binary is available (e.g. Windows).
     */
    private _handleApiRequest(webview: vscode.Webview, data: ApiRequestMessage) {
        const scriptPath = path.join(this._extensionUri.fsPath, 'scripts', 'dreamhost_api.py');
        this._spawnPythonBridge(['python3', 'python'], scriptPath, webview, data);
    }

    private _spawnPythonBridge(
        executables: string[],
        scriptPath: string,
        webview: vscode.Webview,
        data: ApiRequestMessage
    ) {
        const [exe, ...rest] = executables;
        const python = spawn(exe, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

        const payload = JSON.stringify({ key: data.apiKey, cmd: data.cmd, params: data.params ?? {} });
        python.stdin.write(payload);
        python.stdin.end();

        let stdout = '';
        python.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        python.stderr.on('data', (chunk: Buffer) => { console.error(`[dreamhost_api.py]: ${chunk.toString()}`); });

        python.on('close', () => {
            let response: { result: string; data: unknown };
            try {
                response = JSON.parse(stdout) as { result: string; data: unknown };
            } catch {
                response = { result: 'error', data: 'Failed to parse response from Python bridge.' };
            }
            webview.postMessage({ type: 'apiResponse', id: data.id, result: response.result, data: response.data });
        });

        python.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT' && rest.length > 0) {
                // Binary not found — try the next candidate
                this._spawnPythonBridge(rest, scriptPath, webview, data);
                return;
            }
            webview.postMessage({
                type: 'apiResponse',
                id: data.id,
                result: 'error',
                data: `Could not start Python bridge (tried: ${[exe, ...rest].join(', ')}): ${err.message}. ` +
                      `Ensure Python 3 is installed and run 'npm run setup:python'.`
            });
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'dist', 'assets', 'index.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'dist', 'assets', 'index.css')
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <title>DreamDeploy</title>
            </head>
            <body>
                <div id="root"></div>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

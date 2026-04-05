import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SftpClient = require('ssh2-sftp-client');

// ─── SFTP Manager ───────────────────────────────────────────────────────────

interface SftpConnectOptions {
    host: string;
    port: number;
    username: string;
    password: string;
}

interface RemoteFileInfo {
    name: string;
    type: string; // '-' for file, 'd' for directory
    size: number;
    modifyTime: number;
}

class SftpManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _client: any = null;
    private _connected = false;

    get connected(): boolean { return this._connected; }

    async connect(opts: SftpConnectOptions): Promise<void> {
        if (this._connected) { await this.disconnect(); }
        this._client = new SftpClient();
        await this._client.connect({
            host: opts.host,
            port: opts.port,
            username: opts.username,
            password: opts.password,
        });
        this._connected = true;
    }

    async disconnect(): Promise<void> {
        if (this._client && this._connected) {
            try { await this._client.end(); } catch { /* ignore */ }
        }
        this._client = null;
        this._connected = false;
    }

    async list(remotePath: string): Promise<RemoteFileInfo[]> {
        this._assertConnected();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries: any[] = await this._client.list(remotePath);
        return entries.map((e: RemoteFileInfo) => ({
            name: e.name,
            type: e.type,
            size: e.size,
            modifyTime: e.modifyTime,
        }));
    }

    async get(remotePath: string, localPath: string): Promise<void> {
        this._assertConnected();
        await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
        await this._client.fastGet(remotePath, localPath);
    }

    async put(localPath: string, remotePath: string): Promise<void> {
        this._assertConnected();
        const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
        await this._client.mkdir(remoteDir, true);
        await this._client.fastPut(localPath, remotePath);
    }

    async putDirectory(localDir: string, remoteBase: string, ignorePatterns: string[]): Promise<string[]> {
        this._assertConnected();
        const uploaded: string[] = [];
        await this._walkAndPut(localDir, localDir, remoteBase, ignorePatterns, uploaded);
        return uploaded;
    }

    private async _walkAndPut(
        baseDir: string,
        currentDir: string,
        remoteBase: string,
        ignorePatterns: string[],
        uploaded: string[]
    ): Promise<void> {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            if (ignorePatterns.some(p => entry.name === p || entry.name.startsWith(p))) { continue; }
            const localFull = path.join(currentDir, entry.name);
            const relative = path.relative(baseDir, localFull).replace(/\\/g, '/');
            const remoteFull = `${remoteBase.replace(/\/$/, '')}/${relative}`;
            if (entry.isDirectory()) {
                await this._client.mkdir(remoteFull, true);
                await this._walkAndPut(baseDir, localFull, remoteBase, ignorePatterns, uploaded);
            } else {
                await this._client.fastPut(localFull, remoteFull);
                uploaded.push(relative);
            }
        }
    }

    async delete(remotePath: string): Promise<void> {
        this._assertConnected();
        await this._client.delete(remotePath);
    }

    private _assertConnected(): void {
        if (!this._connected) { throw new Error('SFTP not connected. Use the Files tab to connect first.'); }
    }
}

// ─── Remote File Explorer (TreeDataProvider) ─────────────────────────────────

class RemoteFileItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly isDirectory: boolean,
        public readonly remotePath: string,
        public readonly size: number = 0,
    ) {
        super(label, isDirectory
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        this.contextValue = isDirectory ? 'remoteDirectory' : 'remoteFile';
        this.iconPath = new vscode.ThemeIcon(isDirectory ? 'folder' : 'file');
        if (!isDirectory) {
            this.description = `${(size / 1024).toFixed(1)} KB`;
        }
    }
}

class RemoteExplorerProvider implements vscode.TreeDataProvider<RemoteFileItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<RemoteFileItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly _sftp: SftpManager, private _rootPath: string) {}

    refresh(): void { this._onDidChangeTreeData.fire(undefined); }

    setRootPath(p: string): void { this._rootPath = p; this.refresh(); }

    getTreeItem(element: RemoteFileItem): vscode.TreeItem { return element; }

    async getChildren(element?: RemoteFileItem): Promise<RemoteFileItem[]> {
        if (!this._sftp.connected) { return []; }
        const dirPath = element ? element.remotePath : this._rootPath;
        try {
            const files = await this._sftp.list(dirPath);
            return files
                .sort((a, b) => {
                    if (a.type === 'd' && b.type !== 'd') { return -1; }
                    if (a.type !== 'd' && b.type === 'd') { return 1; }
                    return a.name.localeCompare(b.name);
                })
                .map(f => new RemoteFileItem(f.name, f.type === 'd', `${dirPath}/${f.name}`.replace('//', '/'), f.size));
        } catch (err) {
            vscode.window.showErrorMessage(`Remote listing failed: ${(err as Error).message}`);
            return [];
        }
    }
}

// ─── Extension message types ─────────────────────────────────────────────────

interface ApiRequestMessage {
    type: 'apiRequest';
    id: string;
    apiKey: string;
    cmd: string;
    params?: Record<string, string>;
}

interface SftpConnectMessage {
    type: 'sftpConnect';
    host: string;
    port: number;
    username: string;
    password: string;
    remotePath: string;
}

interface SftpListMessage {
    type: 'sftpList';
    remotePath: string;
}

interface SftpGetMessage {
    type: 'sftpGet';
    remotePath: string;
}

interface SftpPutMessage {
    type: 'sftpPut';
    localPath: string;
    remotePath: string;
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    const sftp = new SftpManager();
    const cfg = () => vscode.workspace.getConfiguration('dreamdeploy');
    const connectedKey = 'dreamdeploy.connected';

    const explorerProvider = new RemoteExplorerProvider(sftp, cfg().get<string>('remotePath', '/'));

    const provider = new DreamDeployWebviewProvider(context.extensionUri, sftp, explorerProvider);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(DreamDeployWebviewProvider.viewType, provider),
        vscode.window.registerTreeDataProvider('dreamdeploy.remoteExplorer', explorerProvider),
    );

    // ── Commands ──────────────────────────────────────────────────────────────

    const doConnect = async () => {
        const host = cfg().get<string>('host', '');
        const port = cfg().get<number>('port', 22);
        const username = cfg().get<string>('username', '');
        if (!host || !username) {
            vscode.window.showWarningMessage('Set dreamdeploy.host and dreamdeploy.username in settings first.');
            return;
        }
        const password = await vscode.window.showInputBox({
            prompt: `Password for ${username}@${host}`,
            password: true,
        });
        if (password === undefined) { return; }
        try {
            await sftp.connect({ host, port, username, password });
            vscode.commands.executeCommand('setContext', connectedKey, true);
            explorerProvider.setRootPath(cfg().get<string>('remotePath', '/'));
            vscode.window.showInformationMessage(`DreamDeploy: Connected to ${host}`);
        } catch (err) {
            vscode.window.showErrorMessage(`DreamDeploy: Connection failed — ${(err as Error).message}`);
        }
    };

    const doDisconnect = async () => {
        await sftp.disconnect();
        vscode.commands.executeCommand('setContext', connectedKey, false);
        explorerProvider.refresh();
        vscode.window.showInformationMessage('DreamDeploy: Disconnected');
    };

    const doPushFile = async (uri?: vscode.Uri) => {
        const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) { vscode.window.showWarningMessage('No file selected.'); return; }
        if (!sftp.connected) { vscode.window.showWarningMessage('Not connected. Run DreamDeploy: Connect first.'); return; }
        const ws = vscode.workspace.getWorkspaceFolder(fileUri)?.uri.fsPath ?? path.dirname(fileUri.fsPath);
        const relative = path.relative(ws, fileUri.fsPath).replace(/\\/g, '/');
        const remoteBase = cfg().get<string>('remotePath', '/');
        const remotePath = `${remoteBase.replace(/\/$/, '')}/${relative}`;
        try {
            await sftp.put(fileUri.fsPath, remotePath);
            vscode.window.showInformationMessage(`Pushed: ${relative}`);
            explorerProvider.refresh();
        } catch (err) {
            vscode.window.showErrorMessage(`Push failed: ${(err as Error).message}`);
        }
    };

    const doPushWorkspace = async () => {
        if (!sftp.connected) { vscode.window.showWarningMessage('Not connected. Run DreamDeploy: Connect first.'); return; }
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
        const remoteBase = cfg().get<string>('remotePath', '/');
        const ignorePatterns = cfg().get<string[]>('ignorePatterns', ['.git', 'node_modules', '.DS_Store']);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'DreamDeploy: Pushing workspace…', cancellable: false },
            async (progress) => {
                for (const folder of folders) {
                    progress.report({ message: folder.name });
                    try {
                        const uploaded = await sftp.putDirectory(folder.uri.fsPath, remoteBase, ignorePatterns);
                        vscode.window.showInformationMessage(`Pushed ${uploaded.length} files from ${folder.name}`);
                    } catch (err) {
                        vscode.window.showErrorMessage(`Workspace push failed: ${(err as Error).message}`);
                    }
                }
                explorerProvider.refresh();
            }
        );
    };

    const doPullFile = async (item?: RemoteFileItem) => {
        if (!sftp.connected) { vscode.window.showWarningMessage('Not connected.'); return; }
        const remotePath = item?.remotePath ?? await vscode.window.showInputBox({ prompt: 'Remote path to pull' });
        if (!remotePath) { return; }
        const folders = vscode.workspace.workspaceFolders;
        const localBase = folders?.[0]?.uri.fsPath ?? (vscode.env.appRoot);
        const fileName = remotePath.split('/').pop() ?? 'downloaded_file';
        const localPath = path.join(localBase, fileName);
        try {
            await sftp.get(remotePath, localPath);
            const doc = await vscode.workspace.openTextDocument(localPath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`Pulled: ${fileName}`);
        } catch (err) {
            vscode.window.showErrorMessage(`Pull failed: ${(err as Error).message}`);
        }
    };

    const doRefresh = () => explorerProvider.refresh();

    const doDeleteRemoteFile = async (item?: RemoteFileItem) => {
        if (!sftp.connected || !item) { return; }
        const confirm = await vscode.window.showWarningMessage(
            `Delete remote file: ${item.remotePath}?`, { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { return; }
        try {
            await sftp.delete(item.remotePath);
            explorerProvider.refresh();
        } catch (err) {
            vscode.window.showErrorMessage(`Delete failed: ${(err as Error).message}`);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('dreamdeploy.connect', doConnect),
        vscode.commands.registerCommand('dreamdeploy.disconnect', doDisconnect),
        vscode.commands.registerCommand('dreamdeploy.pushFile', doPushFile),
        vscode.commands.registerCommand('dreamdeploy.pushWorkspace', doPushWorkspace),
        vscode.commands.registerCommand('dreamdeploy.pullFile', doPullFile),
        vscode.commands.registerCommand('dreamdeploy.refreshRemote', doRefresh),
        vscode.commands.registerCommand('dreamdeploy.deleteRemoteFile', doDeleteRemoteFile),
    );

    // ── Upload-on-save file watcher ───────────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if (!cfg().get<boolean>('uploadOnSave', false)) { return; }
            if (!sftp.connected) { return; }
            await doPushFile(doc.uri);
        })
    );
}

// ─── Webview Provider ─────────────────────────────────────────────────────────

class DreamDeployWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'dreamdeploy.sidebarView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _sftp: SftpManager,
        private readonly _explorer: RemoteExplorerProvider,
    ) {}

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

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'apiRequest':
                    this._handleApiRequest(webviewView.webview, data as ApiRequestMessage);
                    break;
                case 'sftpConnect':
                    await this._handleSftpConnect(webviewView.webview, data as SftpConnectMessage);
                    break;
                case 'sftpDisconnect':
                    await this._handleSftpDisconnect(webviewView.webview);
                    break;
                case 'sftpList':
                    await this._handleSftpList(webviewView.webview, data as SftpListMessage);
                    break;
                case 'sftpGet':
                    await this._handleSftpGet(webviewView.webview, data as SftpGetMessage);
                    break;
                case 'sftpPut':
                    await this._handleSftpPut(webviewView.webview, data as SftpPutMessage);
                    break;
                case 'sftpPutWorkspace':
                    await this._handleSftpPutWorkspace(webviewView.webview, data.remotePath as string);
                    break;
                case 'deploy':
                    await this._handleDeploy(webviewView.webview, data.value as string);
                    break;
                case 'log':
                    console.log(`[Webview Log]: ${data.value}`);
                    break;
            }
        });
    }

    // ── DreamHost API bridge ──────────────────────────────────────────────────

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

    // ── SFTP handlers ─────────────────────────────────────────────────────────

    private async _handleSftpConnect(webview: vscode.Webview, data: SftpConnectMessage): Promise<void> {
        try {
            await this._sftp.connect({ host: data.host, port: data.port, username: data.username, password: data.password });
            vscode.commands.executeCommand('setContext', 'dreamdeploy.connected', true);
            this._explorer.setRootPath(data.remotePath || '/');
            webview.postMessage({ type: 'sftpStatus', connected: true, remotePath: data.remotePath || '/', message: `Connected to ${data.host}` });
        } catch (err) {
            webview.postMessage({ type: 'sftpStatus', connected: false, message: (err as Error).message });
        }
    }

    private async _handleSftpDisconnect(webview: vscode.Webview): Promise<void> {
        await this._sftp.disconnect();
        vscode.commands.executeCommand('setContext', 'dreamdeploy.connected', false);
        this._explorer.refresh();
        webview.postMessage({ type: 'sftpStatus', connected: false, message: 'Disconnected' });
    }

    private async _handleSftpList(webview: vscode.Webview, data: SftpListMessage): Promise<void> {
        try {
            const files = await this._sftp.list(data.remotePath);
            webview.postMessage({ type: 'sftpFiles', remotePath: data.remotePath, files });
        } catch (err) {
            webview.postMessage({ type: 'sftpError', message: (err as Error).message });
        }
    }

    private async _handleSftpGet(webview: vscode.Webview, data: SftpGetMessage): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        const localBase = folders?.[0]?.uri.fsPath;
        if (!localBase) {
            webview.postMessage({ type: 'sftpError', message: 'No workspace folder open to save the file into.' });
            return;
        }
        const fileName = data.remotePath.split('/').pop() ?? 'remote_file';
        const localPath = path.join(localBase, fileName);
        try {
            await this._sftp.get(data.remotePath, localPath);
            const doc = await vscode.workspace.openTextDocument(localPath);
            await vscode.window.showTextDocument(doc);
            webview.postMessage({ type: 'sftpResult', success: true, message: `Downloaded: ${fileName}` });
        } catch (err) {
            webview.postMessage({ type: 'sftpError', message: (err as Error).message });
        }
    }

    private async _handleSftpPut(webview: vscode.Webview, data: SftpPutMessage): Promise<void> {
        try {
            await this._sftp.put(data.localPath, data.remotePath);
            this._explorer.refresh();
            webview.postMessage({ type: 'sftpResult', success: true, message: `Uploaded: ${path.basename(data.localPath)}` });
        } catch (err) {
            webview.postMessage({ type: 'sftpError', message: (err as Error).message });
        }
    }

    private async _handleSftpPutWorkspace(webview: vscode.Webview, remotePath: string): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            webview.postMessage({ type: 'sftpError', message: 'No workspace folder open.' });
            return;
        }
        const cfg = vscode.workspace.getConfiguration('dreamdeploy');
        const ignorePatterns = cfg.get<string[]>('ignorePatterns', ['.git', 'node_modules', '.DS_Store']);
        let totalUploaded = 0;
        for (const folder of folders) {
            try {
                webview.postMessage({ type: 'sftpResult', success: true, message: `Uploading ${folder.name}…` });
                const uploaded = await this._sftp.putDirectory(folder.uri.fsPath, remotePath, ignorePatterns);
                totalUploaded += uploaded.length;
                webview.postMessage({ type: 'sftpResult', success: true, message: `Uploaded ${uploaded.length} files from ${folder.name}` });
            } catch (err) {
                webview.postMessage({ type: 'sftpError', message: (err as Error).message });
            }
        }
        this._explorer.refresh();
        webview.postMessage({ type: 'deployComplete', totalFiles: totalUploaded });
    }

    private async _handleDeploy(webview: vscode.Webview, domain: string): Promise<void> {
        if (!this._sftp.connected) {
            webview.postMessage({ type: 'sftpError', message: 'Not connected to SFTP. Use the Files tab to connect first.' });
            return;
        }
        const cfg = vscode.workspace.getConfiguration('dreamdeploy');
        const remotePath = cfg.get<string>('remotePath', `/home/${domain}/`);
        await this._handleSftpPutWorkspace(webview, remotePath);
        vscode.window.showInformationMessage(`DreamDeploy: Deployed to ${domain}`);
    }

    // ── HTML shell ────────────────────────────────────────────────────────────

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

/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activate = activate;
const vscode = __importStar(__webpack_require__(1));
const child_process_1 = __webpack_require__(2);
const path = __importStar(__webpack_require__(3));
const fs = __importStar(__webpack_require__(4));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SftpClient = __webpack_require__(5);
class SftpManager {
    constructor() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this._client = null;
        this._connected = false;
    }
    get connected() { return this._connected; }
    async connect(opts) {
        if (this._connected) {
            await this.disconnect();
        }
        this._client = new SftpClient();
        await this._client.connect({
            host: opts.host,
            port: opts.port,
            username: opts.username,
            password: opts.password,
        });
        this._connected = true;
    }
    async disconnect() {
        if (this._client && this._connected) {
            try {
                await this._client.end();
            }
            catch { /* ignore */ }
        }
        this._client = null;
        this._connected = false;
    }
    async list(remotePath) {
        this._assertConnected();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries = await this._client.list(remotePath);
        return entries.map((e) => ({
            name: e.name,
            type: e.type,
            size: e.size,
            modifyTime: e.modifyTime,
        }));
    }
    async get(remotePath, localPath) {
        this._assertConnected();
        await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
        await this._client.fastGet(remotePath, localPath);
    }
    async put(localPath, remotePath) {
        this._assertConnected();
        const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
        await this._client.mkdir(remoteDir, true);
        await this._client.fastPut(localPath, remotePath);
    }
    async putDirectory(localDir, remoteBase, ignorePatterns) {
        this._assertConnected();
        const uploaded = [];
        await this._walkAndPut(localDir, localDir, remoteBase, ignorePatterns, uploaded);
        return uploaded;
    }
    async _walkAndPut(baseDir, currentDir, remoteBase, ignorePatterns, uploaded) {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            if (ignorePatterns.some(p => entry.name === p || entry.name.startsWith(p))) {
                continue;
            }
            const localFull = path.join(currentDir, entry.name);
            const relative = path.relative(baseDir, localFull).replace(/\\/g, '/');
            const remoteFull = `${remoteBase.replace(/\/$/, '')}/${relative}`;
            if (entry.isDirectory()) {
                await this._client.mkdir(remoteFull, true);
                await this._walkAndPut(baseDir, localFull, remoteBase, ignorePatterns, uploaded);
            }
            else {
                await this._client.fastPut(localFull, remoteFull);
                uploaded.push(relative);
            }
        }
    }
    async delete(remotePath) {
        this._assertConnected();
        await this._client.delete(remotePath);
    }
    _assertConnected() {
        if (!this._connected) {
            throw new Error('SFTP not connected. Use the Files tab to connect first.');
        }
    }
}
// ─── Remote File Explorer (TreeDataProvider) ─────────────────────────────────
class RemoteFileItem extends vscode.TreeItem {
    constructor(label, isDirectory, remotePath, size = 0) {
        super(label, isDirectory
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        this.label = label;
        this.isDirectory = isDirectory;
        this.remotePath = remotePath;
        this.size = size;
        this.contextValue = isDirectory ? 'remoteDirectory' : 'remoteFile';
        this.iconPath = new vscode.ThemeIcon(isDirectory ? 'folder' : 'file');
        if (!isDirectory) {
            this.description = `${(size / 1024).toFixed(1)} KB`;
        }
    }
}
class RemoteExplorerProvider {
    constructor(_sftp, _rootPath) {
        this._sftp = _sftp;
        this._rootPath = _rootPath;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() { this._onDidChangeTreeData.fire(undefined); }
    setRootPath(p) { this._rootPath = p; this.refresh(); }
    getTreeItem(element) { return element; }
    async getChildren(element) {
        if (!this._sftp.connected) {
            return [];
        }
        const dirPath = element ? element.remotePath : this._rootPath;
        try {
            const files = await this._sftp.list(dirPath);
            return files
                .sort((a, b) => {
                if (a.type === 'd' && b.type !== 'd') {
                    return -1;
                }
                if (a.type !== 'd' && b.type === 'd') {
                    return 1;
                }
                return a.name.localeCompare(b.name);
            })
                .map(f => new RemoteFileItem(f.name, f.type === 'd', `${dirPath}/${f.name}`.replace('//', '/'), f.size));
        }
        catch (err) {
            vscode.window.showErrorMessage(`Remote listing failed: ${err.message}`);
            return [];
        }
    }
}
// ─── Activation ───────────────────────────────────────────────────────────────
function activate(context) {
    const sftp = new SftpManager();
    const cfg = () => vscode.workspace.getConfiguration('dreamdeploy');
    const connectedKey = 'dreamdeploy.connected';
    const explorerProvider = new RemoteExplorerProvider(sftp, cfg().get('remotePath', '/'));
    const provider = new DreamDeployWebviewProvider(context.extensionUri, sftp, explorerProvider);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(DreamDeployWebviewProvider.viewType, provider), vscode.window.registerTreeDataProvider('dreamdeploy.remoteExplorer', explorerProvider));
    // ── Commands ──────────────────────────────────────────────────────────────
    const doConnect = async () => {
        const host = cfg().get('host', '');
        const port = cfg().get('port', 22);
        const username = cfg().get('username', '');
        if (!host || !username) {
            vscode.window.showWarningMessage('Set dreamdeploy.host and dreamdeploy.username in settings first.');
            return;
        }
        const password = await vscode.window.showInputBox({
            prompt: `Password for ${username}@${host}`,
            password: true,
        });
        if (password === undefined) {
            return;
        }
        try {
            await sftp.connect({ host, port, username, password });
            vscode.commands.executeCommand('setContext', connectedKey, true);
            explorerProvider.setRootPath(cfg().get('remotePath', '/'));
            vscode.window.showInformationMessage(`DreamDeploy: Connected to ${host}`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`DreamDeploy: Connection failed — ${err.message}`);
        }
    };
    const doDisconnect = async () => {
        await sftp.disconnect();
        vscode.commands.executeCommand('setContext', connectedKey, false);
        explorerProvider.refresh();
        vscode.window.showInformationMessage('DreamDeploy: Disconnected');
    };
    const doPushFile = async (uri) => {
        const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) {
            vscode.window.showWarningMessage('No file selected.');
            return;
        }
        if (!sftp.connected) {
            vscode.window.showWarningMessage('Not connected. Run DreamDeploy: Connect first.');
            return;
        }
        const ws = vscode.workspace.getWorkspaceFolder(fileUri)?.uri.fsPath ?? path.dirname(fileUri.fsPath);
        const relative = path.relative(ws, fileUri.fsPath).replace(/\\/g, '/');
        const remoteBase = cfg().get('remotePath', '/');
        const remotePath = `${remoteBase.replace(/\/$/, '')}/${relative}`;
        try {
            await sftp.put(fileUri.fsPath, remotePath);
            vscode.window.showInformationMessage(`Pushed: ${relative}`);
            explorerProvider.refresh();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Push failed: ${err.message}`);
        }
    };
    const doPushWorkspace = async () => {
        if (!sftp.connected) {
            vscode.window.showWarningMessage('Not connected. Run DreamDeploy: Connect first.');
            return;
        }
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.window.showWarningMessage('No workspace folder open.');
            return;
        }
        const remoteBase = cfg().get('remotePath', '/');
        const ignorePatterns = cfg().get('ignorePatterns', ['.git', 'node_modules', '.DS_Store']);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'DreamDeploy: Pushing workspace…', cancellable: false }, async (progress) => {
            for (const folder of folders) {
                progress.report({ message: folder.name });
                try {
                    const uploaded = await sftp.putDirectory(folder.uri.fsPath, remoteBase, ignorePatterns);
                    vscode.window.showInformationMessage(`Pushed ${uploaded.length} files from ${folder.name}`);
                }
                catch (err) {
                    vscode.window.showErrorMessage(`Workspace push failed: ${err.message}`);
                }
            }
            explorerProvider.refresh();
        });
    };
    const doPullFile = async (item) => {
        if (!sftp.connected) {
            vscode.window.showWarningMessage('Not connected.');
            return;
        }
        const remotePath = item?.remotePath ?? await vscode.window.showInputBox({ prompt: 'Remote path to pull' });
        if (!remotePath) {
            return;
        }
        const folders = vscode.workspace.workspaceFolders;
        const localBase = folders?.[0]?.uri.fsPath ?? (vscode.env.appRoot);
        const fileName = remotePath.split('/').pop() ?? 'downloaded_file';
        const localPath = path.join(localBase, fileName);
        try {
            await sftp.get(remotePath, localPath);
            const doc = await vscode.workspace.openTextDocument(localPath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`Pulled: ${fileName}`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Pull failed: ${err.message}`);
        }
    };
    const doRefresh = () => explorerProvider.refresh();
    const doDeleteRemoteFile = async (item) => {
        if (!sftp.connected || !item) {
            return;
        }
        const confirm = await vscode.window.showWarningMessage(`Delete remote file: ${item.remotePath}?`, { modal: true }, 'Delete');
        if (confirm !== 'Delete') {
            return;
        }
        try {
            await sftp.delete(item.remotePath);
            explorerProvider.refresh();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('dreamdeploy.connect', doConnect), vscode.commands.registerCommand('dreamdeploy.disconnect', doDisconnect), vscode.commands.registerCommand('dreamdeploy.pushFile', doPushFile), vscode.commands.registerCommand('dreamdeploy.pushWorkspace', doPushWorkspace), vscode.commands.registerCommand('dreamdeploy.pullFile', doPullFile), vscode.commands.registerCommand('dreamdeploy.refreshRemote', doRefresh), vscode.commands.registerCommand('dreamdeploy.deleteRemoteFile', doDeleteRemoteFile));
    // ── Upload-on-save file watcher ───────────────────────────────────────────
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (!cfg().get('uploadOnSave', false)) {
            return;
        }
        if (!sftp.connected) {
            return;
        }
        await doPushFile(doc.uri);
    }));
}
// ─── Webview Provider ─────────────────────────────────────────────────────────
class DreamDeployWebviewProvider {
    constructor(_extensionUri, _sftp, _explorer) {
        this._extensionUri = _extensionUri;
        this._sftp = _sftp;
        this._explorer = _explorer;
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'apiRequest':
                    this._handleApiRequest(webviewView.webview, data);
                    break;
                case 'sftpConnect':
                    await this._handleSftpConnect(webviewView.webview, data);
                    break;
                case 'sftpDisconnect':
                    await this._handleSftpDisconnect(webviewView.webview);
                    break;
                case 'sftpList':
                    await this._handleSftpList(webviewView.webview, data);
                    break;
                case 'sftpGet':
                    await this._handleSftpGet(webviewView.webview, data);
                    break;
                case 'sftpPut':
                    await this._handleSftpPut(webviewView.webview, data);
                    break;
                case 'sftpPutWorkspace':
                    await this._handleSftpPutWorkspace(webviewView.webview, data.remotePath);
                    break;
                case 'deploy':
                    await this._handleDeploy(webviewView.webview, data.value);
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
    _handleApiRequest(webview, data) {
        const scriptPath = path.join(this._extensionUri.fsPath, 'scripts', 'dreamhost_api.py');
        this._spawnPythonBridge(['python3', 'python'], scriptPath, webview, data);
    }
    _spawnPythonBridge(executables, scriptPath, webview, data) {
        const [exe, ...rest] = executables;
        const python = (0, child_process_1.spawn)(exe, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
        const payload = JSON.stringify({ key: data.apiKey, cmd: data.cmd, params: data.params ?? {} });
        python.stdin.write(payload);
        python.stdin.end();
        let stdout = '';
        python.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        python.stderr.on('data', (chunk) => { console.error(`[dreamhost_api.py]: ${chunk.toString()}`); });
        python.on('close', () => {
            let response;
            try {
                response = JSON.parse(stdout);
            }
            catch {
                response = { result: 'error', data: 'Failed to parse response from Python bridge.' };
            }
            webview.postMessage({ type: 'apiResponse', id: data.id, result: response.result, data: response.data });
        });
        python.on('error', (err) => {
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
    async _handleSftpConnect(webview, data) {
        try {
            await this._sftp.connect({ host: data.host, port: data.port, username: data.username, password: data.password });
            vscode.commands.executeCommand('setContext', 'dreamdeploy.connected', true);
            this._explorer.setRootPath(data.remotePath || '/');
            webview.postMessage({ type: 'sftpStatus', connected: true, remotePath: data.remotePath || '/', message: `Connected to ${data.host}` });
        }
        catch (err) {
            webview.postMessage({ type: 'sftpStatus', connected: false, message: err.message });
        }
    }
    async _handleSftpDisconnect(webview) {
        await this._sftp.disconnect();
        vscode.commands.executeCommand('setContext', 'dreamdeploy.connected', false);
        this._explorer.refresh();
        webview.postMessage({ type: 'sftpStatus', connected: false, message: 'Disconnected' });
    }
    async _handleSftpList(webview, data) {
        try {
            const files = await this._sftp.list(data.remotePath);
            webview.postMessage({ type: 'sftpFiles', remotePath: data.remotePath, files });
        }
        catch (err) {
            webview.postMessage({ type: 'sftpError', message: err.message });
        }
    }
    async _handleSftpGet(webview, data) {
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
        }
        catch (err) {
            webview.postMessage({ type: 'sftpError', message: err.message });
        }
    }
    async _handleSftpPut(webview, data) {
        try {
            await this._sftp.put(data.localPath, data.remotePath);
            this._explorer.refresh();
            webview.postMessage({ type: 'sftpResult', success: true, message: `Uploaded: ${path.basename(data.localPath)}` });
        }
        catch (err) {
            webview.postMessage({ type: 'sftpError', message: err.message });
        }
    }
    async _handleSftpPutWorkspace(webview, remotePath) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            webview.postMessage({ type: 'sftpError', message: 'No workspace folder open.' });
            return;
        }
        const cfg = vscode.workspace.getConfiguration('dreamdeploy');
        const ignorePatterns = cfg.get('ignorePatterns', ['.git', 'node_modules', '.DS_Store']);
        let totalUploaded = 0;
        for (const folder of folders) {
            try {
                webview.postMessage({ type: 'sftpResult', success: true, message: `Uploading ${folder.name}…` });
                const uploaded = await this._sftp.putDirectory(folder.uri.fsPath, remotePath, ignorePatterns);
                totalUploaded += uploaded.length;
                webview.postMessage({ type: 'sftpResult', success: true, message: `Uploaded ${uploaded.length} files from ${folder.name}` });
            }
            catch (err) {
                webview.postMessage({ type: 'sftpError', message: err.message });
            }
        }
        this._explorer.refresh();
        webview.postMessage({ type: 'deployComplete', totalFiles: totalUploaded });
    }
    async _handleDeploy(webview, domain) {
        if (!this._sftp.connected) {
            webview.postMessage({ type: 'sftpError', message: 'Not connected to SFTP. Use the Files tab to connect first.' });
            return;
        }
        const cfg = vscode.workspace.getConfiguration('dreamdeploy');
        const remotePath = cfg.get('remotePath', `/home/${domain}/`);
        await this._handleSftpPutWorkspace(webview, remotePath);
        vscode.window.showInformationMessage(`DreamDeploy: Deployed to ${domain}`);
    }
    // ── HTML shell ────────────────────────────────────────────────────────────
    _getHtmlForWebview(webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'dist', 'assets', 'index.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'dist', 'assets', 'index.css'));
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
DreamDeployWebviewProvider.viewType = 'dreamdeploy.sidebarView';
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}


/***/ }),
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),
/* 2 */
/***/ ((module) => {

module.exports = require("child_process");

/***/ }),
/* 3 */
/***/ ((module) => {

module.exports = require("path");

/***/ }),
/* 4 */
/***/ ((module) => {

module.exports = require("fs");

/***/ }),
/* 5 */
/***/ ((module) => {

module.exports = require("ssh2-sftp-client");

/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map
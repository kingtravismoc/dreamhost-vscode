import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  UploadCloud, CheckCircle, Loader2, Plus, Terminal,
  Globe, FolderOpen, Activity, ChevronRight, ChevronDown,
  Download, Upload, Trash2, RefreshCw, Server, Users,
  LayoutGrid, Wifi, WifiOff
} from 'lucide-react';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

// VS Code API Bridge (acquireVsCodeApi may only be called once)
const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;

// ── Types ──────────────────────────────────────────────────────────────────────

interface SiteDetails {
  domain: string;
  dbName: string;
  dbUser: string;
  dbPass: string;
}

interface LogEntry {
  id: number;
  msg: string;
  type: string;
}

interface ApiResponse {
  type: 'apiResponse';
  id: string;
  result: 'success' | 'error';
  data: unknown;
}

interface SftpStatusMessage {
  type: 'sftpStatus';
  connected: boolean;
  remotePath?: string;
  message: string;
}

interface SftpFilesMessage {
  type: 'sftpFiles';
  remotePath: string;
  files: RemoteFile[];
}

interface SftpResultMessage {
  type: 'sftpResult';
  success: boolean;
  message: string;
}

interface SftpErrorMessage {
  type: 'sftpError';
  message: string;
}

interface DeployCompleteMessage {
  type: 'deployComplete';
  totalFiles: number;
}

interface RemoteFile {
  name: string;
  type: string; // '-' or 'd'
  size: number;
  modifyTime: number;
}

interface DomainEntry {
  domain: string;
  type?: string;
  account_id?: string;
}

interface UserEntry {
  username: string;
  type?: string;
  home?: string;
}

interface AppEntry {
  name: string;
  install_path?: string;
  version?: string;
}

type Tab = 'deploy' | 'domains' | 'files' | 'status';

// Pending DreamHost API request callbacks keyed by request id
const pendingRequests = new Map<string, (response: ApiResponse) => void>();

// ── App ────────────────────────────────────────────────────────────────────────

let _logIdCounter = 0;
const nextLogId = () => ++_logIdCounter;

const App = () => {
  // Global state
  const [apiKey, setApiKey] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('deploy');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Deploy tab
  const [deployStep, setDeployStep] = useState<'config' | 'deploy'>('config');
  const [deployLoading, setDeployLoading] = useState(false);
  const [siteDetails, setSiteDetails] = useState<SiteDetails>({ domain: '', dbName: '', dbUser: '', dbPass: '' });

  // Domains tab
  const [domains, setDomains] = useState<DomainEntry[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [newSubdomain, setNewSubdomain] = useState('');
  const [subdomainParent, setSubdomainParent] = useState('');
  const [domainMsg, setDomainMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Files tab
  const [sftpHost, setSftpHost] = useState('');
  const [sftpPort, setSftpPort] = useState('22');
  const [sftpUser, setSftpUser] = useState('');
  const [sftpPass, setSftpPass] = useState('');
  const [sftpRemotePath, setSftpRemotePath] = useState('/');
  const [sftpConnected, setSftpConnected] = useState(false);
  const [sftpLoading, setSftpLoading] = useState(false);
  const [remoteFiles, setRemoteFiles] = useState<RemoteFile[]>([]);
  const [currentRemotePath, setCurrentRemotePath] = useState('/');
  const [pathHistory, setPathHistory] = useState<string[]>([]);

  // Status tab
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [statusLoading, setStatusLoading] = useState(false);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Listen for messages from the extension host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data as
        ApiResponse | SftpStatusMessage | SftpFilesMessage |
        SftpResultMessage | SftpErrorMessage | DeployCompleteMessage;

      switch (message.type) {
        case 'apiResponse': {
          const resolve = pendingRequests.get(message.id);
          if (typeof resolve === 'function') {
            pendingRequests.delete(message.id);
            resolve(message);
          }
          break;
        }
        case 'sftpStatus': {
          setSftpConnected(message.connected);
          setSftpLoading(false);
          addLog(message.message, message.connected ? 'success' : 'info');
          if (message.connected && message.remotePath) {
            setCurrentRemotePath(message.remotePath);
            requestSftpList(message.remotePath);
          }
          break;
        }
        case 'sftpFiles': {
          setRemoteFiles(message.files);
          setCurrentRemotePath(message.remotePath);
          setSftpLoading(false);
          break;
        }
        case 'sftpResult': {
          addLog(message.message, message.success ? 'success' : 'error');
          setSftpLoading(false);
          setDeployLoading(false);
          break;
        }
        case 'sftpError': {
          addLog(`SFTP Error: ${message.message}`, 'error');
          setSftpLoading(false);
          setDeployLoading(false);
          break;
        }
        case 'deployComplete': {
          addLog(`Deploy complete — ${message.totalFiles} file(s) pushed`, 'success');
          setDeployLoading(false);
          break;
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [addLog, requestSftpList]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const addLog = useCallback((msg: string, type = 'info') => {
    setLogs(prev => [...prev, { id: nextLogId(), msg, type }]);
    if (vscode) { vscode.postMessage({ type: 'log', value: msg }); }
  }, []);

  const requestSftpList = useCallback((remotePath: string) => {
    if (!vscode) { return; }
    setSftpLoading(true);
    vscode.postMessage({ type: 'sftpList', remotePath });
  }, []);

  const dreamHostRequest = (cmd: string, params: Record<string, string> = {}): Promise<ApiResponse> => {
    return new Promise((resolve, reject) => {
      if (!vscode) { reject(new Error('Not running inside VS Code')); return; }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingRequests.set(id, (response) => {
        if (response.result === 'error') { reject(new Error(String(response.data))); }
        else { resolve(response); }
      });
      vscode.postMessage({ type: 'apiRequest', id, apiKey, cmd, params });
    });
  };

  const startInfrastructure = async () => {
    setDeployLoading(true);
    addLog('Initializing DreamHost infrastructure…');
    try {
      await dreamHostRequest('domain-add_domain', { domain: siteDetails.domain });
      addLog('Domain hosting provisioned', 'success');
      await dreamHostRequest('mysql-add_db', {
        db: siteDetails.dbName || `db_${Math.floor(Math.random() * 9999)}`,
        type: 'mysql',
        host: `mysql.${siteDetails.domain}`,
      });
      addLog('Database created', 'success');
      setDeployStep('deploy');
    } catch (err) {
      addLog(`Provisioning failed: ${(err as Error).message}`, 'error');
    } finally {
      setDeployLoading(false);
    }
  };

  const handleDeploy = () => {
    if (!sftpConnected) {
      addLog('Not connected to SFTP — go to the Files tab to connect first', 'error');
      return;
    }
    setDeployLoading(true);
    addLog('Pushing workspace to live server…');
    if (vscode) { vscode.postMessage({ type: 'deploy', value: siteDetails.domain }); }
  };

  // ── Domains tab handlers ──────────────────────────────────────────────────

  const loadDomains = async () => {
    if (!apiKey) { addLog('Enter your API key first', 'error'); return; }
    setDomainsLoading(true);
    setDomainMsg(null);
    try {
      const res = await dreamHostRequest('domain-list_domains');
      const list = Array.isArray(res.data) ? res.data as DomainEntry[] : [];
      setDomains(list);
      addLog(`Loaded ${list.length} domain(s)`, 'success');
    } catch (err) {
      addLog(`Failed to load domains: ${(err as Error).message}`, 'error');
    } finally {
      setDomainsLoading(false);
    }
  };

  const createDomain = async () => {
    if (!newDomain) { return; }
    setDomainsLoading(true);
    setDomainMsg(null);
    try {
      await dreamHostRequest('domain-add_hosting', { domain: newDomain, type: 'fully_hosted' });
      addLog(`Domain created: ${newDomain}`, 'success');
      setDomainMsg({ text: `Domain ${newDomain} created successfully`, ok: true });
      setNewDomain('');
      await loadDomains();
    } catch (err) {
      const msg = (err as Error).message;
      addLog(`Domain creation failed: ${msg}`, 'error');
      setDomainMsg({ text: msg, ok: false });
      setDomainsLoading(false);
    }
  };

  const createSubdomain = async () => {
    if (!newSubdomain || !subdomainParent) { return; }
    const fullSub = `${newSubdomain}.${subdomainParent}`;
    setDomainsLoading(true);
    setDomainMsg(null);
    try {
      await dreamHostRequest('domain-add_hosting', { domain: fullSub, type: 'fully_hosted' });
      addLog(`Subdomain created: ${fullSub}`, 'success');
      setDomainMsg({ text: `Subdomain ${fullSub} created successfully`, ok: true });
      setNewSubdomain('');
      await loadDomains();
    } catch (err) {
      const msg = (err as Error).message;
      addLog(`Subdomain creation failed: ${msg}`, 'error');
      setDomainMsg({ text: msg, ok: false });
      setDomainsLoading(false);
    }
  };

  // ── Files tab handlers ────────────────────────────────────────────────────

  const connectSftp = () => {
    if (!vscode || !sftpHost || !sftpUser) { return; }
    setSftpLoading(true);
    vscode.postMessage({
      type: 'sftpConnect',
      host: sftpHost,
      port: parseInt(sftpPort, 10) || 22,
      username: sftpUser,
      password: sftpPass,
      remotePath: sftpRemotePath || '/',
    });
  };

  const disconnectSftp = () => {
    if (!vscode) { return; }
    setSftpLoading(true);
    vscode.postMessage({ type: 'sftpDisconnect' });
    setRemoteFiles([]);
    setPathHistory([]);
  };

  const navigateTo = (remotePath: string) => {
    setPathHistory(prev => [...prev, currentRemotePath]);
    requestSftpList(remotePath);
  };

  const navigateBack = () => {
    const prev = pathHistory[pathHistory.length - 1];
    if (!prev) { return; }
    setPathHistory(h => h.slice(0, -1));
    requestSftpList(prev);
  };

  const downloadFile = (file: RemoteFile) => {
    if (!vscode || file.type === 'd') { return; }
    const remotePath = `${currentRemotePath.replace(/\/$/, '')}/${file.name}`;
    addLog(`Downloading ${file.name}…`);
    vscode.postMessage({ type: 'sftpGet', remotePath });
  };

  const uploadCurrentFile = () => {
    if (!vscode) { return; }
    // The extension will use the active editor's file
    const remotePath = `${currentRemotePath.replace(/\/$/, '')}/`;
    addLog('Uploading active file…');
    setSftpLoading(true);
    vscode.postMessage({ type: 'sftpPutWorkspace', remotePath: currentRemotePath });
  };

  // ── Status tab handlers ───────────────────────────────────────────────────

  const loadStatus = async () => {
    if (!apiKey) { addLog('Enter your API key first', 'error'); return; }
    setStatusLoading(true);
    try {
      const [usersRes, appsRes] = await Promise.allSettled([
        dreamHostRequest('user-list_users_no_pw'),
        dreamHostRequest('application-list'),
      ]);
      if (usersRes.status === 'fulfilled') {
        setUsers(Array.isArray(usersRes.value.data) ? usersRes.value.data as UserEntry[] : []);
        addLog(`Loaded ${Array.isArray(usersRes.value.data) ? (usersRes.value.data as UserEntry[]).length : 0} user(s)`, 'success');
      } else {
        addLog(`Users: ${usersRes.reason?.message ?? 'error'}`, 'error');
      }
      if (appsRes.status === 'fulfilled') {
        setApps(Array.isArray(appsRes.value.data) ? appsRes.value.data as AppEntry[] : []);
      } else {
        addLog(`Apps: ${appsRes.reason?.message ?? 'error'}`, 'error');
      }
    } finally {
      setStatusLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const tabs: { id: Tab; label: string; Icon: React.ElementType }[] = [
    { id: 'deploy', label: 'Deploy', Icon: UploadCloud },
    { id: 'domains', label: 'Domains', Icon: Globe },
    { id: 'files', label: 'Files', Icon: FolderOpen },
    { id: 'status', label: 'Status', Icon: Activity },
  ];

  return (
    <div className="flex flex-col h-screen bg-vscode-background text-[13px] overflow-hidden select-none">
      {/* Header */}
      <div className="p-3 border-b border-white/10 bg-black/20 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <UploadCloud size={14} className="text-blue-400" />
          <span className="font-bold tracking-tight uppercase text-[11px]">DreamDeploy</span>
        </div>
        <div className="flex items-center gap-2">
          {sftpConnected
            ? <Wifi size={12} className="text-green-400" title="SFTP Connected" />
            : <WifiOff size={12} className="text-white/30" title="SFTP Disconnected" />}
        </div>
      </div>

      {/* API Key (always visible) */}
      <div className="px-3 pt-2 pb-1 shrink-0">
        <input
          type="password"
          className="w-full bg-black/20 border border-white/10 px-2 py-1 rounded text-[11px] focus:border-blue-500 outline-none"
          placeholder="DreamHost API Key"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
        />
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-white/10 shrink-0">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex-1 flex flex-col items-center py-1.5 gap-0.5 text-[9px] uppercase font-bold transition-colors
              ${activeTab === id ? 'text-blue-400 border-b border-blue-400' : 'text-white/40 hover:text-white/70'}`}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">

        {/* ── DEPLOY tab ── */}
        {activeTab === 'deploy' && (
          <div className="space-y-3">
            {deployStep === 'config' ? (
              <div className="space-y-3">
                <Field label="Domain">
                  <input
                    className={inputCls}
                    placeholder="example.com"
                    value={siteDetails.domain}
                    onChange={e => setSiteDetails({ ...siteDetails, domain: e.target.value })}
                  />
                </Field>
                <Field label="DB Name (optional)">
                  <input
                    className={inputCls}
                    placeholder="auto-generated if blank"
                    value={siteDetails.dbName}
                    onChange={e => setSiteDetails({ ...siteDetails, dbName: e.target.value })}
                  />
                </Field>
                <Btn
                  onClick={startInfrastructure}
                  disabled={!apiKey || !siteDetails.domain || deployLoading}
                  loading={deployLoading}
                  icon={<Plus size={12} />}
                >
                  Initialize Server
                </Btn>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-green-500/10 border border-green-500/20 p-2 rounded flex gap-2 text-[11px]">
                  <CheckCircle size={12} className="text-green-500 shrink-0 mt-0.5" />
                  <span className="text-green-200">Server ready at {siteDetails.domain}</span>
                </div>
                {!sftpConnected && (
                  <div className="bg-yellow-500/10 border border-yellow-500/20 p-2 rounded text-yellow-300 text-[11px]">
                    ⚠ Connect via the Files tab for live push to work.
                  </div>
                )}
                <Btn
                  onClick={handleDeploy}
                  disabled={deployLoading}
                  loading={deployLoading}
                  color="green"
                >
                  Push Workspace to Live
                </Btn>
                <button onClick={() => setDeployStep('config')} className="w-full opacity-40 hover:opacity-100 text-[11px]">
                  ← Back to Settings
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── DOMAINS tab ── */}
        {activeTab === 'domains' && (
          <div className="space-y-3">
            {/* List domains */}
            <div className="flex gap-2">
              <Btn onClick={loadDomains} loading={domainsLoading} icon={<RefreshCw size={11} />} className="flex-1">
                List All Domains
              </Btn>
            </div>

            {domains.length > 0 && (
              <div className="rounded border border-white/10 overflow-hidden">
                <div className="text-[9px] uppercase font-bold opacity-40 px-2 py-1 bg-white/5 border-b border-white/10">
                  {domains.length} Domain{domains.length !== 1 ? 's' : ''}
                </div>
                <div className="max-h-40 overflow-y-auto divide-y divide-white/5">
                  {domains.map((d, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/5">
                      <Globe size={10} className="text-blue-400 shrink-0" />
                      <span className="truncate text-[11px]">{d.domain}</span>
                      {d.type && <span className="ml-auto text-[9px] opacity-40">{d.type}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <hr className="border-white/10" />

            {/* Create domain */}
            <div className="space-y-2">
              <SectionLabel icon={<Plus size={10} />}>Create Domain</SectionLabel>
              <input
                className={inputCls}
                placeholder="newdomain.com"
                value={newDomain}
                onChange={e => setNewDomain(e.target.value)}
              />
              <Btn onClick={createDomain} disabled={!newDomain || !apiKey || domainsLoading} loading={domainsLoading} icon={<Globe size={11} />}>
                Add Domain
              </Btn>
            </div>

            <hr className="border-white/10" />

            {/* Create subdomain */}
            <div className="space-y-2">
              <SectionLabel icon={<ChevronRight size={10} />}>Create Subdomain</SectionLabel>
              <input
                className={inputCls}
                placeholder="sub"
                value={newSubdomain}
                onChange={e => setNewSubdomain(e.target.value)}
              />
              <input
                className={inputCls}
                placeholder="parent.com"
                value={subdomainParent}
                onChange={e => setSubdomainParent(e.target.value)}
              />
              {newSubdomain && subdomainParent && (
                <div className="text-[10px] opacity-50 font-mono">{newSubdomain}.{subdomainParent}</div>
              )}
              <Btn
                onClick={createSubdomain}
                disabled={!newSubdomain || !subdomainParent || !apiKey || domainsLoading}
                loading={domainsLoading}
                icon={<ChevronRight size={11} />}
              >
                Add Subdomain
              </Btn>
            </div>

            {domainMsg && (
              <div className={`p-2 rounded text-[11px] ${domainMsg.ok ? 'bg-green-500/10 text-green-300 border border-green-500/20' : 'bg-red-500/10 text-red-300 border border-red-500/20'}`}>
                {domainMsg.text}
              </div>
            )}
          </div>
        )}

        {/* ── FILES tab ── */}
        {activeTab === 'files' && (
          <div className="space-y-3">
            {!sftpConnected ? (
              <div className="space-y-2">
                <SectionLabel icon={<Server size={10} />}>SFTP Connection</SectionLabel>
                <Field label="Host">
                  <input className={inputCls} placeholder="ftp.example.com" value={sftpHost} onChange={e => setSftpHost(e.target.value)} />
                </Field>
                <div className="flex gap-2">
                  <Field label="Port" className="w-20 shrink-0">
                    <input className={inputCls} placeholder="22" value={sftpPort} onChange={e => setSftpPort(e.target.value)} />
                  </Field>
                  <Field label="Username" className="flex-1">
                    <input className={inputCls} placeholder="user" value={sftpUser} onChange={e => setSftpUser(e.target.value)} />
                  </Field>
                </div>
                <Field label="Password">
                  <input type="password" className={inputCls} placeholder="••••••••" value={sftpPass} onChange={e => setSftpPass(e.target.value)} />
                </Field>
                <Field label="Remote Path">
                  <input className={inputCls} placeholder="/" value={sftpRemotePath} onChange={e => setSftpRemotePath(e.target.value)} />
                </Field>
                <Btn onClick={connectSftp} disabled={!sftpHost || !sftpUser || sftpLoading} loading={sftpLoading} icon={<Wifi size={11} />}>
                  Connect
                </Btn>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 font-mono text-[10px] opacity-60 truncate">{currentRemotePath}</div>
                  <button onClick={() => requestSftpList(currentRemotePath)} className="text-white/40 hover:text-white/80">
                    <RefreshCw size={11} />
                  </button>
                  <button onClick={disconnectSftp} className="text-red-400/60 hover:text-red-400 text-[10px] flex items-center gap-1">
                    <WifiOff size={11} /> Disconnect
                  </button>
                </div>

                {/* Breadcrumb nav */}
                {pathHistory.length > 0 && (
                  <button onClick={navigateBack} className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300">
                    <ChevronDown size={10} className="rotate-90" /> Back
                  </button>
                )}

                {/* File listing */}
                {sftpLoading ? (
                  <div className="flex items-center justify-center py-4 opacity-40">
                    <Loader2 size={14} className="animate-spin" />
                  </div>
                ) : (
                  <div className="rounded border border-white/10 overflow-hidden">
                    <div className="max-h-52 overflow-y-auto divide-y divide-white/5">
                      {remoteFiles.length === 0 && (
                        <div className="py-4 text-center opacity-30 text-[11px]">Empty directory</div>
                      )}
                      {remoteFiles.map((file, i) => (
                        <div key={i} className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/5 group">
                          {file.type === 'd'
                            ? <FolderOpen size={10} className="text-yellow-400 shrink-0" />
                            : <LayoutGrid size={10} className="text-blue-300 shrink-0" />}
                          <button
                            className="flex-1 text-left truncate text-[11px]"
                            onClick={() => file.type === 'd'
                              ? navigateTo(`${currentRemotePath.replace(/\/$/, '')}/${file.name}`)
                              : downloadFile(file)
                            }
                          >
                            {file.name}
                          </button>
                          {file.type !== 'd' && (
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button title="Download" onClick={() => downloadFile(file)} className="text-blue-400 hover:text-blue-300">
                                <Download size={10} />
                              </button>
                            </div>
                          )}
                          {file.type !== 'd' && (
                            <span className="text-[9px] opacity-30 shrink-0">{(file.size / 1024).toFixed(1)}K</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Upload actions */}
                <div className="flex gap-2 pt-1">
                  <Btn onClick={uploadCurrentFile} loading={sftpLoading} icon={<Upload size={11} />} className="flex-1">
                    Push Workspace
                  </Btn>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── STATUS tab ── */}
        {activeTab === 'status' && (
          <div className="space-y-3">
            <Btn onClick={loadStatus} loading={statusLoading} icon={<RefreshCw size={11} />}>
              Refresh Status
            </Btn>

            {/* Users */}
            <div>
              <SectionLabel icon={<Users size={10} />}>Users ({users.length})</SectionLabel>
              {users.length > 0 ? (
                <div className="rounded border border-white/10 divide-y divide-white/5 mt-1">
                  {users.map((u, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                      <Server size={10} className="text-green-400 shrink-0" />
                      <span className="truncate">{u.username}</span>
                      {u.type && <span className="ml-auto text-[9px] opacity-40">{u.type}</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] opacity-30 mt-1">No users loaded — click Refresh Status</div>
              )}
            </div>

            {/* Apps */}
            <div>
              <SectionLabel icon={<LayoutGrid size={10} />}>One-Click Apps ({apps.length})</SectionLabel>
              {apps.length > 0 ? (
                <div className="rounded border border-white/10 divide-y divide-white/5 mt-1">
                  {apps.map((a, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                      <LayoutGrid size={10} className="text-purple-400 shrink-0" />
                      <span className="truncate">{a.name}</span>
                      {a.version && <span className="ml-auto text-[9px] opacity-40">v{a.version}</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] opacity-30 mt-1">No apps loaded — click Refresh Status</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Output log */}
      <div className="shrink-0 bg-black/40 border-t border-white/5 flex flex-col" style={{ height: '110px' }}>
        <div className="px-2 py-1 border-b border-white/5 flex items-center gap-2 text-[9px] opacity-40 font-bold uppercase">
          <Terminal size={9} /> Output
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-1 font-mono text-[10px] space-y-0.5">
          {logs.map(log => (
            <div key={log.id} className={log.type === 'error' ? 'text-red-400' : log.type === 'success' ? 'text-green-400' : 'text-blue-300'}>
              {log.msg}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
};

// ── Reusable mini-components ────────────────────────────────────────────────

const inputCls = 'w-full bg-black/20 border border-white/10 px-2 py-1 rounded text-[11px] focus:border-blue-500 outline-none';

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1 ${className}`}>
      <label className="text-[9px] font-bold opacity-40 uppercase">{label}</label>
      {children}
    </div>
  );
}

function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 text-[9px] font-bold opacity-50 uppercase mb-1">
      {icon} {children}
    </div>
  );
}

function Btn({
  onClick, disabled = false, loading = false, children, icon, color = 'blue', className = ''
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
  icon?: React.ReactNode;
  color?: 'blue' | 'green';
  className?: string;
}) {
  const base = color === 'green'
    ? 'bg-green-600 hover:bg-green-500'
    : 'bg-blue-600 hover:bg-blue-500';
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`w-full ${base} disabled:opacity-30 text-white py-1.5 rounded font-medium flex items-center justify-center gap-1.5 text-[11px] transition-all ${className}`}
    >
      {loading ? <Loader2 size={11} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

export default App;


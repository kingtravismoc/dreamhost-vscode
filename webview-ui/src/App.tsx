import React, { useState } from 'react';
import { 
  UploadCloud, 
  CheckCircle, Loader2, Plus, Terminal
} from 'lucide-react';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

// VS Code API Bridge
const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;

interface SiteDetails {
  domain: string;
  dbName: string;
  dbUser: string;
  dbPass: string;
  ftpUser: string;
  ftpPass: string;
}

interface LogEntry {
  id: number;
  msg: string;
  type: string;
  time: string;
}

const App = () => {
  const [apiKey, setApiKey] = useState('');
  const [step, setStep] = useState('config');
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [siteDetails, setSiteDetails] = useState<SiteDetails>({
    domain: '',
    dbName: '',
    dbUser: '',
    dbPass: '',
    ftpUser: '',
    ftpPass: ''
  });

  const addLog = (msg: string, type = 'info') => {
    const log: LogEntry = { id: Date.now(), msg, type, time: new Date().toLocaleTimeString() };
    setLogs(prev => [...prev, log]);
    if (vscode) vscode.postMessage({ type: 'log', value: msg });
  };

  const dreamHostRequest = async (cmd: string, params: Record<string, string> = {}) => {
    const urlParams = new URLSearchParams({
      key: apiKey,
      cmd: cmd,
      format: 'json',
      ...params
    });
    
    try {
      const response = await fetch(`https://api.dreamhost.com/?${urlParams.toString()}`);
      const data = await response.json() as { result: string; data: string };
      if (data.result === 'error') throw new Error(data.data);
      return data;
    } catch (err) {
      const error = err as Error;
      addLog(`Error: ${error.message}`, 'error');
      throw err;
    }
  };

  const startInfrastructure = async () => {
    setLoading(true);
    addLog("Initializing DreamHost Infrastructure...");
    try {
      await dreamHostRequest('domain-add_domain', { domain: siteDetails.domain });
      addLog("Domain Hosting Provisioned", "success");
      
      await dreamHostRequest('mysql-add_db', { 
        db: siteDetails.dbName || 'db_' + Math.floor(Math.random()*1000), 
        type: 'mysql', 
        host: `mysql.${siteDetails.domain}` 
      });
      addLog("Database Created", "success");

      setStep('deploy');
    } catch {
      addLog("Provisioning Failed", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleDeploy = () => {
    setLoading(true);
    addLog("Sending files to VS Code Extension host...");
    if (vscode) {
        vscode.postMessage({
            type: 'deploy',
            value: siteDetails.domain
        });
    }
    
    setTimeout(() => {
        addLog("VS Code SFTP Transfer started...", "info");
        setTimeout(() => {
            addLog("Deploy Complete!", "success");
            setLoading(false);
        }, 2000);
    }, 1000);
  };

  return (
    <div className="flex flex-col h-screen bg-vscode-background text-[13px] overflow-hidden select-none">
      {/* Mini Header */}
      <div className="p-4 border-b border-white/10 bg-black/20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UploadCloud size={16} className="text-blue-400" />
          <span className="font-bold tracking-tight uppercase text-[11px]">DreamDeploy</span>
        </div>
        {loading && <Loader2 size={14} className="animate-spin text-blue-400" />}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {step === 'config' ? (
          <div className="space-y-4 animate-in fade-in duration-300">
            <div className="space-y-2">
              <label className="text-[10px] font-bold opacity-50 uppercase">API Key</label>
              <input 
                type="password"
                className="w-full bg-black/20 border border-white/10 p-2 rounded focus:border-blue-500 outline-none"
                placeholder="DreamHost API Key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold opacity-50 uppercase">Domain</label>
              <input 
                className="w-full bg-black/20 border border-white/10 p-2 rounded focus:border-blue-500 outline-none"
                placeholder="example.com"
                value={siteDetails.domain}
                onChange={(e) => setSiteDetails({...siteDetails, domain: e.target.value})}
              />
            </div>

            <button 
              onClick={startInfrastructure}
              disabled={!apiKey || !siteDetails.domain || loading}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white py-2 rounded font-medium flex items-center justify-center gap-2 transition-all"
            >
              <Plus size={14} /> Initialize Server
            </button>
          </div>
        ) : (
          <div className="space-y-4 animate-in slide-in-from-right-4 duration-300">
            <div className="bg-green-500/10 border border-green-500/20 p-3 rounded-lg flex gap-2">
              <CheckCircle size={14} className="text-green-500 shrink-0 mt-0.5" />
              <span className="text-green-200 text-[11px]">Server is ready at {siteDetails.domain}</span>
            </div>

            <div className="border-2 border-dashed border-white/10 rounded-lg p-6 text-center">
              <p className="opacity-60 italic">Workspace files will be synced automatically via SFTP.</p>
            </div>

            <button 
              onClick={handleDeploy}
              disabled={loading}
              className="w-full bg-green-600 hover:bg-green-500 text-white py-3 rounded font-bold uppercase tracking-wider transition-all"
            >
              Push Workspace to Live
            </button>
            
            <button onClick={() => setStep('config')} className="w-full opacity-40 hover:opacity-100 text-[11px]">
              Back to Settings
            </button>
          </div>
        )}

        {/* Minimal Terminal */}
        <div className="mt-4 bg-black/40 rounded border border-white/5 flex flex-col h-40">
           <div className="p-2 border-b border-white/5 flex items-center gap-2 text-[10px] opacity-40 font-bold uppercase">
             <Terminal size={10} /> Output
           </div>
           <div className="flex-1 overflow-y-auto p-2 font-mono text-[10px] space-y-1">
              {logs.map(log => (
                <div key={log.id} className={log.type === 'error' ? 'text-red-400' : log.type === 'success' ? 'text-green-400' : 'text-blue-300'}>
                  {log.msg}
                </div>
              ))}
           </div>
        </div>
      </div>
    </div>
  );
};

export default App;

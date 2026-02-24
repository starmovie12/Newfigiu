'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Bolt, Link as LinkIcon, Rocket, Loader2, RotateCcw, AlertTriangle, CircleCheck, History, ChevronRight, ChevronDown, Video, Film, Globe, Volume2, Sparkles, Home, Clock, CheckCircle2, XCircle, Trash2, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import LinkCard from '@/components/LinkCard';

interface LogEntry {
  msg: string;
  type: 'info' | 'success' | 'error' | 'warn';
}

interface Task {
  id: string;
  url: string;
  status: 'processing' | 'completed' | 'failed';
  createdAt: string;
  links: any[];
  error?: string;
  preview?: {
    title: string;
    posterUrl: string | null;
  };
  metadata?: {
    quality: string;
    languages: string;
    audioLabel: string;
  };
}

// =============================================
// Tab types for bottom navigation
// =============================================
type TabType = 'home' | 'processing' | 'completed' | 'failed' | 'history';

// =============================================
// 12-hour time format helper
// =============================================
function formatTime12h(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return isoString;
  }
}

// =============================================
// Link stats calculator (used for non-streaming tasks)
// =============================================
function getLinkStats(links: any[]): { total: number; done: number; failed: number; pending: number } {
  if (!links || links.length === 0) return { total: 0, done: 0, failed: 0, pending: 0 };
  let done = 0, failed = 0, pending = 0;
  for (const link of links) {
    const s = (link.status || '').toLowerCase();
    if (s === 'done' || s === 'success') done++;
    else if (s === 'error' || s === 'failed') failed++;
    else pending++;
  }
  return { total: links.length, done, failed, pending };
}

// =============================================
// Completed link snapshot — survives stream lifecycle
// =============================================
interface CompletedLinkSnapshot {
  status: string;
  finalLink: string | null;
  logs: LogEntry[];
}

export default function MflixApp() {
  const [url, setUrl] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  // Active tab state
  const [activeTab, setActiveTab] = useState<TabType>('home');

  // Live stream state
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<Record<number, LogEntry[]>>({});
  const [liveLinks, setLiveLinks] = useState<Record<number, string | null>>({});
  const [liveStatuses, setLiveStatuses] = useState<Record<number, string>>({});

  // Deleting / Retrying state
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);

  // Track which tasks we've already auto-started streams for (prevent duplicate streams)
  const streamStartedRef = useRef<Set<string>>(new Set());

  // ==========================================================================
  // GHOST REVERSION FIX — KEY NEW REF:
  //
  // completedLinksRef stores terminal link states (done/error) that PERSIST
  // even after the stream ends. This is checked by fetchTasks to prevent
  // stale Firebase data from overwriting successful results.
  //
  // Structure: Map<taskId, Map<linkIndex, CompletedLinkSnapshot>>
  // ==========================================================================
  const completedLinksRef = useRef<Map<string, Map<number, CompletedLinkSnapshot>>>(new Map());

  // Tracks when a stream finished, so we can give Firebase time to catch up
  const streamEndedAtRef = useRef<Map<string, number>>(new Map());

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchTasks();
    pollRef.current = setInterval(fetchTasks, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // ==========================================================================
  // GHOST REVERSION FIX: fetchTasks now has 3 layers of protection:
  //
  // Layer 1: streamStartedRef — blocks overwrite during active stream (existing)
  // Layer 2: completedLinksRef — blocks downgrade of terminal link states
  //          even AFTER stream ends (NEW — this is the key fix)
  // Layer 3: streamEndedAtRef — 30s grace period after stream ends before
  //          allowing full replacement (NEW — safety net)
  // ==========================================================================
  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) {
        const text = await res.text();
        if (text.includes("Rate exceeded")) return;
        throw new Error(`Server error: ${res.status}`);
      }
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        setTasks(prevTasks => {
          const currentlyStreamingIds = streamStartedRef.current;
          const completedSnapshots = completedLinksRef.current;
          const streamEndTimes = streamEndedAtRef.current;
          const now = Date.now();

          return data.map((serverTask: Task) => {
            // Layer 1: Active stream — keep entire local task
            if (currentlyStreamingIds.has(serverTask.id)) {
              const localTask = prevTasks.find(t => t.id === serverTask.id);
              if (localTask) return localTask;
            }

            // Layer 3: Recently ended stream — give Firebase time to catch up
            const endedAt = streamEndTimes.get(serverTask.id);
            if (endedAt && (now - endedAt) < 15000) {
              // Within 15s of stream ending — use local task if available
              const localTask = prevTasks.find(t => t.id === serverTask.id);
              if (localTask) return localTask;
            }

            // Layer 2: Check completedLinksRef — protect individual link states
            const taskSnapshots = completedSnapshots.get(serverTask.id);
            if (taskSnapshots && taskSnapshots.size > 0 && serverTask.links) {
              let anyProtected = false;

              const protectedLinks = serverTask.links.map((serverLink: any, idx: number) => {
                const snapshot = taskSnapshots.get(idx);
                if (!snapshot) return serverLink;

                const serverStatus = (serverLink.status || '').toLowerCase();
                const snapshotStatus = snapshot.status.toLowerCase();

                // If Firebase says "pending" but we KNOW it's "done" — protect it
                if (
                  (snapshotStatus === 'done' || snapshotStatus === 'success') &&
                  serverStatus !== 'done' && serverStatus !== 'success'
                ) {
                  anyProtected = true;
                  return {
                    ...serverLink,
                    status: snapshot.status,
                    finalLink: snapshot.finalLink || serverLink.finalLink,
                    logs: snapshot.logs.length > 0 ? snapshot.logs : serverLink.logs,
                  };
                }

                // If Firebase already confirms the terminal state, we can clear the snapshot
                if (
                  (serverStatus === 'done' || serverStatus === 'success') &&
                  (snapshotStatus === 'done' || snapshotStatus === 'success')
                ) {
                  taskSnapshots.delete(idx);
                }

                return serverLink;
              });

              // Clean up empty snapshot maps
              if (taskSnapshots.size === 0) {
                completedSnapshots.delete(serverTask.id);
                streamEndTimes.delete(serverTask.id);
              }

              if (anyProtected) {
                return { ...serverTask, links: protectedLinks };
              }
            }

            return serverTask;
          });
        });
      }
    } catch (e) {
      console.error('Failed to fetch tasks:', e);
    }
  };

  // ==========================================================================
  // getEffectiveStats: compute counter values from live state or Firebase
  // ==========================================================================
  const getEffectiveStats = useCallback((task: Task): { total: number; done: number; failed: number; pending: number } => {
    const isLive = activeTaskId === task.id;

    if (!isLive) {
      return getLinkStats(task.links);
    }

    const total = task.links.length;
    let done = 0, failed = 0, pending = 0;

    for (let i = 0; i < total; i++) {
      const liveStatus = liveStatuses[i];
      if (liveStatus) {
        const s = liveStatus.toLowerCase();
        if (s === 'done' || s === 'success') done++;
        else if (s === 'error' || s === 'failed') failed++;
        else pending++;
      } else {
        const origStatus = (task.links[i]?.status || '').toLowerCase();
        if (origStatus === 'done' || origStatus === 'success') done++;
        else if (origStatus === 'error' || origStatus === 'failed') failed++;
        else pending++;
      }
    }

    return { total, done, failed, pending };
  }, [activeTaskId, liveStatuses]);

  // ==========================================================================
  // startLiveStream: Stream solving in real-time via SSE (NDJSON)
  //
  // GHOST REVERSION FIX: Every terminal SSE event is saved to
  // completedLinksRef so it persists even after the stream ends.
  // ==========================================================================
  const startLiveStream = useCallback(async (taskId: string, links: any[]) => {
    if (streamStartedRef.current.has(taskId)) {
      console.log('[Stream] Already streaming task ' + taskId + ', skipping');
      return;
    }

    const pendingLinks = links
      .map((l: any, idx: number) => ({ ...l, _originalIdx: idx }))
      .filter((l: any) => {
        const s = (l.status || '').toLowerCase();
        return s === 'pending' || s === 'processing' || s === '';
      });

    if (pendingLinks.length === 0) {
      console.log('[Stream] No pending links for task ' + taskId + ', skipping stream');
      return;
    }

    console.log('[Stream] Starting stream for task ' + taskId + ' with ' + pendingLinks.length + ' pending links');
    streamStartedRef.current.add(taskId);
    setActiveTaskId(taskId);

    // Initialize live state for ALL links
    const initialLogs: Record<number, LogEntry[]> = {};
    const initialLinks: Record<number, string | null> = {};
    const initialStatuses: Record<number, string> = {};

    links.forEach((link: any, idx: number) => {
      const s = (link.status || '').toLowerCase();
      if (s === 'done' || s === 'success') {
        initialLogs[idx] = link.logs || [];
        initialLinks[idx] = link.finalLink || null;
        initialStatuses[idx] = 'done';
      } else if (s === 'error' || s === 'failed') {
        initialLogs[idx] = [{ msg: '🔄 Retrying...', type: 'info' }];
        initialLinks[idx] = null;
        initialStatuses[idx] = 'processing';
      } else {
        initialLogs[idx] = [];
        initialLinks[idx] = null;
        initialStatuses[idx] = 'processing';
      }
    });

    setLiveLogs(initialLogs);
    setLiveLinks(initialLinks);
    setLiveStatuses(initialStatuses);

    // Initialize completedLinksRef for this task
    if (!completedLinksRef.current.has(taskId)) {
      completedLinksRef.current.set(taskId, new Map());
    }

    try {
      const linksToSend = pendingLinks.map((l: any) => ({
        id: l._originalIdx,
        name: l.name,
        link: l.link,
      }));

      console.log('[Stream] POST /api/stream_solve with ' + linksToSend.length + ' links');

      const response = await fetch('/api/stream_solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          links: linksToSend,
          taskId
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[Stream] stream_solve returned ' + response.status + ': ' + errText);
        setLiveStatuses(prev => {
          const updated = { ...prev };
          pendingLinks.forEach((l: any) => {
            updated[l._originalIdx] = 'error';
          });
          return updated;
        });
        return;
      }

      if (!response.body) {
        console.error('[Stream] No response body from stream_solve');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const lid = data.id;

            // Accumulate logs
            if (data.msg && data.type) {
              setLiveLogs(prev => ({
                ...prev,
                [lid]: [...(prev[lid] || []), { msg: data.msg, type: data.type }]
              }));
            }

            // Capture final download link
            if (data.final) {
              setLiveLinks(prev => ({ ...prev, [lid]: data.final }));
            }

            // ================================================================
            // GHOST REVERSION FIX: On terminal events, save to BOTH
            // liveStatuses (for UI) AND completedLinksRef (for persistence)
            // ================================================================
            if (data.status === 'done' || data.status === 'error') {
              setLiveStatuses(prev => ({ ...prev, [lid]: data.status }));

              // Save snapshot that survives stream ending
              setLiveLogs(currentLogs => {
                const taskSnapshots = completedLinksRef.current.get(taskId);
                if (taskSnapshots) {
                  taskSnapshots.set(lid, {
                    status: data.status,
                    finalLink: data.final || null,
                    logs: currentLogs[lid] || [],
                  });
                }
                return currentLogs; // no mutation, just reading
              });
            }

            // 'finished' safety net
            if (data.status === 'finished') {
              setLiveStatuses(prev => {
                const currentStatus = prev[lid];
                if (currentStatus !== 'done' && currentStatus !== 'error') {
                  return { ...prev, [lid]: 'error' };
                }
                return prev;
              });
            }
          } catch {
            // skip invalid JSON lines
          }
        }
      }
    } catch (e: any) {
      console.error('[Stream] Stream error:', e);
    } finally {
      // Record when stream ended for grace period
      streamEndedAtRef.current.set(taskId, Date.now());
      streamStartedRef.current.delete(taskId);

      // Snapshot ALL final live states to completedLinksRef before clearing
      setLiveLogs(currentLogs => {
        setLiveLinks(currentLinks => {
          setLiveStatuses(currentStatuses => {
            const taskSnapshots = completedLinksRef.current.get(taskId) || new Map();

            for (const [idxStr, status] of Object.entries(currentStatuses)) {
              const idx = Number(idxStr);
              const s = (status || '').toLowerCase();
              if (s === 'done' || s === 'error') {
                if (!taskSnapshots.has(idx)) {
                  taskSnapshots.set(idx, {
                    status,
                    finalLink: currentLinks[idx] || null,
                    logs: currentLogs[idx] || [],
                  });
                }
              }
            }

            completedLinksRef.current.set(taskId, taskSnapshots);
            return currentStatuses;
          });
          return currentLinks;
        });
        return currentLogs;
      });

      // Fetch fresh data after a delay — Firebase should have incremental saves by now
      setTimeout(fetchTasks, 3000);
      setTimeout(() => setActiveTaskId(null), 500);
    }
  }, []);

  const startProcess = async () => {
    if (!url.trim()) {
      if (navigator.vibrate) navigator.vibrate(50);
      return;
    }

    setIsConnecting(true);
    setError(null);
    setIsDone(false);

    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() })
      });

      if (!response.ok) {
        const text = await response.text();
        if (text.includes("Rate exceeded")) {
          throw new Error("Server is busy (Rate Limit). Please wait a few seconds and try again.");
        }
        throw new Error(`Server error: ${response.status}`);
      }

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error("Received unexpected response format from server.");
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      setIsConnecting(false);
      setIsProcessing(true);

      await fetchTasks();

      if (data.taskId) {
        setExpandedTask(data.taskId);
        setActiveTab('processing');

        try {
          const taskRes = await fetch('/api/tasks');
          const taskResContentType = taskRes.headers.get("content-type");
          if (taskRes.ok && taskResContentType?.includes("application/json")) {
            const taskList = await taskRes.json();
            const newTask = taskList.find((t: any) => t.id === data.taskId);

            if (newTask && newTask.links && newTask.links.length > 0) {
              await startLiveStream(data.taskId, newTask.links);
            }
          }
        } catch (streamErr: any) {
          console.error('[startProcess] Failed to start stream:', streamErr);
        }
      }

      setUrl('');
      setIsProcessing(false);
      setIsDone(true);
      setTimeout(() => setIsDone(false), 3000);

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An error occurred');
      setIsConnecting(false);
      setIsProcessing(false);
    }
  };

  // =============================================
  // Delete a task
  // =============================================
  const handleDeleteTask = async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deletingTaskId) return;

    setDeletingTaskId(taskId);
    try {
      const res = await fetch('/api/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete');
      }

      // Clean up refs for this task
      completedLinksRef.current.delete(taskId);
      streamEndedAtRef.current.delete(taskId);

      setTasks(prev => prev.filter(t => t.id !== taskId));
      if (expandedTask === taskId) setExpandedTask(null);
    } catch (err: any) {
      console.error('Delete failed:', err);
      setError(`Delete failed: ${err.message}`);
    } finally {
      setDeletingTaskId(null);
    }
  };

  // =============================================
  // Retry a failed task
  // =============================================
  const handleRetryTask = async (task: Task, e: React.MouseEvent) => {
    e.stopPropagation();
    if (retryingTaskId) return;

    setRetryingTaskId(task.id);
    try {
      // Clean up refs for old task
      completedLinksRef.current.delete(task.id);
      streamEndedAtRef.current.delete(task.id);

      await fetch('/api/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });

      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: task.url }),
      });

      if (!response.ok) throw new Error(`Server error: ${response.status}`);

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      await fetchTasks();

      if (data.taskId) {
        setExpandedTask(data.taskId);
        setActiveTab('processing');

        try {
          const taskRes = await fetch('/api/tasks');
          const taskResContentType = taskRes.headers.get("content-type");
          if (taskRes.ok && taskResContentType?.includes("application/json")) {
            const taskList = await taskRes.json();
            const newTask = taskList.find((t: any) => t.id === data.taskId);
            if (newTask?.links?.length > 0) {
              await startLiveStream(data.taskId, newTask.links);
            }
          }
        } catch (streamErr: any) {
          console.error('[handleRetryTask] Failed to start stream:', streamErr);
        }
      }
    } catch (err: any) {
      console.error('Retry failed:', err);
      setError(`Retry failed: ${err.message}`);
    } finally {
      setRetryingTaskId(null);
    }
  };

  // ==========================================================================
  // getEffectiveLinkData: prefer live data if streaming, else use Firebase
  // GHOST REVERSION FIX: also checks completedLinksRef as final fallback
  // ==========================================================================
  const getEffectiveLinkData = (task: Task, linkIdx: number, link: any) => {
    const isLive = activeTaskId === task.id;

    if (isLive) {
      return {
        logs: liveLogs[linkIdx] || [],
        finalLink: liveLinks[linkIdx] || link.finalLink || null,
        status: liveStatuses[linkIdx] || 'processing',
      };
    }

    // Not live — check completedLinksRef for protected states
    const taskSnapshots = completedLinksRef.current.get(task.id);
    if (taskSnapshots) {
      const snapshot = taskSnapshots.get(linkIdx);
      if (snapshot) {
        const linkStatus = (link.status || '').toLowerCase();
        const snapStatus = snapshot.status.toLowerCase();

        // If Firebase still says pending but snapshot says done — use snapshot
        if (
          (snapStatus === 'done' || snapStatus === 'success') &&
          linkStatus !== 'done' && linkStatus !== 'success'
        ) {
          return {
            logs: snapshot.logs.length > 0 ? snapshot.logs : (link.logs || []),
            finalLink: snapshot.finalLink || link.finalLink || null,
            status: snapshot.status,
          };
        }
      }
    }

    // Default: use Firebase data
    return {
      logs: link.logs || [],
      finalLink: link.finalLink || null,
      status: link.status || 'done',
    };
  };

  // =============================================
  // Filter tasks based on active tab
  // =============================================
  const getFilteredTasks = (): Task[] => {
    switch (activeTab) {
      case 'processing':
        return tasks.filter(t => t.status === 'processing');
      case 'completed':
        return tasks.filter(t => t.status === 'completed');
      case 'failed':
        return tasks.filter(t => t.status === 'failed');
      case 'history':
        return [...tasks].sort((a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      case 'home':
      default:
        return tasks;
    }
  };

  const filteredTasks = getFilteredTasks();

  const tabLabels: Record<TabType, string> = {
    home: 'Home',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
    history: 'History',
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 pb-28">
      {/* Header */}
      <header className="flex justify-between items-center mb-8">
        <div className="text-2xl font-bold bg-gradient-to-br from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
          <Bolt className="text-indigo-500 fill-indigo-500" />
          MFLIX PRO
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          LIVE ENGINE
        </div>
      </header>

      {/* Input Section — always visible on Home tab */}
      {activeTab === 'home' && (
        <section className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2rem] p-6 mb-8 shadow-2xl">
          <div className="relative mb-4">
            <LinkIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 w-5 h-5" />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && startProcess()}
              placeholder="Paste Movie URL here..."
              className="w-full bg-black/40 border border-white/10 text-white pl-12 pr-4 py-4 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 transition-all font-sans"
            />
          </div>

          <button
            onClick={startProcess}
            disabled={isConnecting || isProcessing || isDone}
            className={`w-full py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all duration-300 shadow-lg active:scale-95 ${
              isDone
                ? 'bg-emerald-500 text-white'
                : error
                  ? 'bg-rose-500 text-white'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-800 disabled:opacity-70'
            }`}
          >
            {isConnecting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                CONNECTING...
              </>
            ) : isProcessing ? (
              <>
                <RotateCcw className="w-5 h-5 animate-spin" />
                PROCESSING LIVE...
              </>
            ) : isDone ? (
              <>
                <CircleCheck className="w-5 h-5" />
                ALL DONE ✅
              </>
            ) : error ? (
              <>
                <AlertTriangle className="w-5 h-5" />
                ERROR - RETRY
              </>
            ) : (
              <>
                START ENGINE
                <Rocket className="w-5 h-5" />
              </>
            )}
          </button>

          {error && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm flex items-center gap-3"
            >
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <p className="flex-1">{error}</p>
              <button onClick={() => setError(null)} className="text-xs font-bold uppercase hover:text-rose-300">Dismiss</button>
            </motion.div>
          )}
        </section>
      )}

      {/* Global error banner (visible on non-home tabs) */}
      {activeTab !== 'home' && error && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm flex items-center gap-3"
        >
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <p className="flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-xs font-bold uppercase hover:text-rose-300">Dismiss</button>
        </motion.div>
      )}

      {/* Section Header */}
      <div className="mb-6 flex items-center gap-2 text-slate-400">
        {activeTab === 'processing' ? <Loader2 className="w-5 h-5 animate-spin" /> :
         activeTab === 'completed' ? <CheckCircle2 className="w-5 h-5" /> :
         activeTab === 'failed' ? <XCircle className="w-5 h-5" /> :
         activeTab === 'history' ? <History className="w-5 h-5" /> :
         <History className="w-5 h-5" />}
        <h3 className="font-bold uppercase tracking-wider text-sm">
          {activeTab === 'home' ? 'Recent Tasks' : `${tabLabels[activeTab]} Tasks`}
        </h3>
        <span className="ml-auto text-[10px] text-slate-600 font-mono">{filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Tasks List */}
      <div className="space-y-4">
        {filteredTasks.map((task) => {
          const stats = getEffectiveStats(task);
          return (
            <div key={task.id} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden transition-all hover:bg-white/[0.07]">
              <div
                className="p-4 flex items-center gap-4 cursor-pointer"
                onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
              >
                {/* Movie Poster Thumbnail */}
                <div className="w-12 h-16 bg-slate-800 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden border border-white/10">
                  {task.preview?.posterUrl ? (
                    <img
                      src={task.preview.posterUrl}
                      alt={task.preview?.title || 'Movie'}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                        (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                      }}
                    />
                  ) : null}
                  <Film className={`w-5 h-5 text-indigo-400 ${task.preview?.posterUrl ? 'hidden' : ''}`} />
                </div>

                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-sm text-white truncate">
                    {task.preview?.title || 'Processing...'}
                  </h4>
                  <p className="font-mono text-[10px] text-slate-500 truncate mt-0.5">{task.url}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                      task.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' :
                      task.status === 'failed' ? 'bg-rose-500/20 text-rose-400' :
                      'bg-indigo-500/20 text-indigo-400 animate-pulse'
                    }`}>
                      {task.status === 'processing' && activeTaskId === task.id ? '⚡ LIVE' : task.status}
                    </span>

                    <span className="text-slate-600 text-[10px]">{formatTime12h(task.createdAt)}</span>

                    {stats.total > 0 && (
                      <div className="flex items-center gap-1">
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-300 font-mono">
                          {stats.total} links
                        </span>
                        {stats.done > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">
                            ✓{stats.done}
                          </span>
                        )}
                        {stats.failed > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 font-mono">
                            ✗{stats.failed}
                          </span>
                        )}
                        {stats.pending > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-mono">
                            ⏳{stats.pending}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {task.status === 'failed' && (
                    <button
                      onClick={(e) => handleRetryTask(task, e)}
                      disabled={retryingTaskId === task.id}
                      className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-all disabled:opacity-50"
                      title="Retry this task"
                    >
                      {retryingTaskId === task.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                    </button>
                  )}

                  <button
                    onClick={(e) => handleDeleteTask(task.id, e)}
                    disabled={deletingTaskId === task.id}
                    className="p-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 transition-all disabled:opacity-50"
                    title="Delete this task"
                  >
                    {deletingTaskId === task.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>

                  {expandedTask === task.id ? <ChevronDown className="w-5 h-5 text-slate-500" /> : <ChevronRight className="w-5 h-5 text-slate-500" />}
                </div>
              </div>

              <AnimatePresence>
                {expandedTask === task.id && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="border-t border-white/5 bg-black/20"
                  >
                    {/* Movie Preview Banner */}
                    {task.preview?.posterUrl && (
                      <div className="relative h-32 overflow-hidden">
                        <img
                          src={task.preview.posterUrl}
                          alt={task.preview?.title || ''}
                          className="w-full h-full object-cover opacity-30 blur-sm"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 to-transparent" />
                        <div className="absolute bottom-3 left-4 right-4">
                          <h3 className="text-lg font-bold text-white truncate">{task.preview?.title}</h3>
                        </div>
                      </div>
                    )}

                    <div className="p-4">
                      {/* Counter Badges — ABOVE metadata */}
                      {stats.total > 0 && (
                        <div className="grid grid-cols-4 gap-2 mb-4">
                          <div className="bg-slate-800/50 border border-white/5 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-slate-500 font-bold">Total</p>
                            <p className="text-lg font-bold text-white">{stats.total}</p>
                          </div>
                          <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-emerald-500 font-bold">Done</p>
                            <p className="text-lg font-bold text-emerald-400">{stats.done}</p>
                          </div>
                          <div className="bg-rose-500/5 border border-rose-500/10 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-rose-500 font-bold">Failed</p>
                            <p className="text-lg font-bold text-rose-400">{stats.failed}</p>
                          </div>
                          <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-amber-500 font-bold">Pending</p>
                            <p className="text-lg font-bold text-amber-400">{stats.pending}</p>
                          </div>
                        </div>
                      )}

                      {/* Metadata Boxes — BELOW counter badges */}
                      {task.metadata && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                              <Sparkles className="w-3 h-3" />
                              Highest Quality
                            </label>
                            <p className="text-sm font-bold text-indigo-400">{task.metadata.quality || 'Unknown'}</p>
                          </div>
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                              <Globe className="w-3 h-3" />
                              Languages
                            </label>
                            <p className="text-sm font-bold text-emerald-400">{task.metadata.languages || 'Not Specified'}</p>
                          </div>
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                              <Volume2 className="w-3 h-3" />
                              Audio Label
                            </label>
                            <p className="text-sm font-bold text-amber-400">{task.metadata.audioLabel || 'Unknown'}</p>
                          </div>
                        </div>
                      )}

                      {/* Processing State with Live Logs */}
                      {(task.status === 'processing' || activeTaskId === task.id) && (
                        <div className="space-y-3">
                          {task.links.map((link: any, idx: number) => {
                            const effective = getEffectiveLinkData(task, idx, link);
                            return (
                              <LinkCard
                                key={idx}
                                id={idx}
                                name={link.name}
                                logs={effective.logs}
                                finalLink={effective.finalLink}
                                status={effective.status as any}
                              />
                            );
                          })}
                          {task.links.length === 0 && (
                            <div className="flex flex-col items-center py-8 text-slate-400">
                              <Loader2 className="w-8 h-8 animate-spin mb-2" />
                              <p className="text-sm">Scraping in progress...</p>
                              <p className="text-xs opacity-50">You can close this window and return later.</p>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Failed State */}
                      {task.status === 'failed' && activeTaskId !== task.id && (
                        <div className="space-y-3">
                          {task.links && task.links.length > 0 ? (
                            task.links.map((link: any, idx: number) => {
                              const effective = getEffectiveLinkData(task, idx, link);
                              return (
                                <LinkCard
                                  key={idx}
                                  id={idx}
                                  name={link.name}
                                  logs={effective.logs}
                                  finalLink={effective.finalLink}
                                  status={effective.status as any}
                                />
                              );
                            })
                          ) : (
                            <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                              <AlertTriangle className="w-5 h-5 mb-2" />
                              {task.error || 'Task failed unexpectedly.'}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Completed State */}
                      {task.status === 'completed' && activeTaskId !== task.id && (
                        <div className="space-y-3">
                          {task.links.map((link: any, idx: number) => {
                            const effective = getEffectiveLinkData(task, idx, link);
                            return (
                              <LinkCard
                                key={idx}
                                id={idx}
                                name={link.name}
                                logs={effective.logs}
                                finalLink={effective.finalLink}
                                status={effective.status as any}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {filteredTasks.length === 0 && (
          <div className="text-center py-12 text-slate-500 border-2 border-dashed border-white/5 rounded-3xl">
            <Rocket className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p>
              {activeTab === 'home'
                ? 'No tasks yet. Submit a URL to start!'
                : `No ${tabLabels[activeTab].toLowerCase()} tasks.`}
            </p>
          </div>
        )}
      </div>

      {/* Fixed Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-xl border-t border-white/10 safe-area-inset-bottom">
        <div className="max-w-2xl mx-auto flex items-stretch justify-around">
          {([
            { key: 'home' as TabType, icon: Home, label: 'Home' },
            { key: 'processing' as TabType, icon: Clock, label: 'Processing' },
            { key: 'completed' as TabType, icon: CheckCircle2, label: 'Completed' },
            { key: 'failed' as TabType, icon: XCircle, label: 'Failed' },
            { key: 'history' as TabType, icon: History, label: 'History' },
          ]).map(({ key, icon: Icon, label }) => {
            const isActive = activeTab === key;
            const count = key === 'processing' ? tasks.filter(t => t.status === 'processing').length :
                          key === 'completed' ? tasks.filter(t => t.status === 'completed').length :
                          key === 'failed' ? tasks.filter(t => t.status === 'failed').length :
                          key === 'history' ? tasks.length : 0;

            return (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex-1 flex flex-col items-center gap-0.5 py-3 px-1 transition-all relative ${
                  isActive
                    ? 'text-indigo-400'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {isActive && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-indigo-500 rounded-full" />
                )}
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {count > 0 && key !== 'home' && (
                    <span className={`absolute -top-1.5 -right-2.5 min-w-[16px] h-4 flex items-center justify-center text-[9px] font-bold rounded-full px-1 ${
                      key === 'failed' ? 'bg-rose-500 text-white' :
                      key === 'processing' ? 'bg-indigo-500 text-white' :
                      key === 'completed' ? 'bg-emerald-500 text-white' :
                      'bg-slate-600 text-white'
                    }`}>
                      {count}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-bold">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

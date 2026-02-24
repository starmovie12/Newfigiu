export const maxDuration = 60;

import { db } from '@/lib/firebaseAdmin';
import { solveHBLinks, solveHubCDN, solveHubDrive, solveHubCloudNative } from '@/lib/solvers';

// =============================================================================
// GHOST REVERSION FIX — KEY ARCHITECTURAL CHANGE:
//
// BEFORE: Firebase was updated in ONE batch AFTER Promise.all() finished.
//         If Vercel killed the function at 10s, NOTHING was saved. The 480p
//         success was lost and the frontend polling pulled stale "pending" data.
//
// AFTER:  Each link persists to Firebase IMMEDIATELY upon completion via
//         Firestore transactions. Even if Vercel kills at 10s, any link that
//         finished at 2s is already safely in Firebase.
// =============================================================================

const API_MAP = {
  timer: 'https://time-page-bay-pass-edhc.onrender.com/solve?url=',
  hblinks: 'https://hblinks-dad.onrender.com/solve?url=',
  hubdrive: 'https://hdhub4u-1.onrender.com/solve?url=',
  hubcdn_bypass: 'https://hubcdn-bypass.onrender.com/extract?url=',
};

// =============================================================================
// HELPER: Persist a single link result to Firebase IMMEDIATELY
// Uses Firestore transaction to safely update only the specific link index.
// =============================================================================
async function persistSingleLinkToFirebase(
  taskId: string,
  linkIdx: number,
  result: any
) {
  try {
    const taskRef = db.collection('scraping_tasks').doc(taskId);

    await db.runTransaction(async (transaction) => {
      const taskDoc = await transaction.get(taskRef);
      if (!taskDoc.exists) return;

      const taskData = taskDoc.data();
      const existingLinks: any[] = taskData?.links || [];

      // Safety: if the link index is out of range, skip
      if (linkIdx < 0 || linkIdx >= existingLinks.length) return;

      // IMPORTANT: Never downgrade a link that's already 'done' in Firebase
      const existingStatus = (existingLinks[linkIdx]?.status || '').toLowerCase();
      if (existingStatus === 'done' || existingStatus === 'success') {
        console.log(`[Firebase] Link #${linkIdx} already done in DB, skipping overwrite`);
        return;
      }

      // Build updated link object
      const existingLink = existingLinks[linkIdx];
      const updatedLink: any = {
        ...existingLink,
        finalLink: result.finalLink || existingLink.finalLink || null,
        status: result.status || 'error',
        error: result.error || null,
        logs: result.logs || existingLink.logs || [],
      };

      // Preserve HubCloud-specific fields
      if (result.best_button_name) {
        updatedLink.best_button_name = result.best_button_name;
      }
      if (result.all_available_buttons?.length > 0) {
        updatedLink.all_available_buttons = result.all_available_buttons;
      }

      // Clone array and update only the changed link
      const updatedLinks = [...existingLinks];
      updatedLinks[linkIdx] = updatedLink;

      // Compute overall task status from ALL links
      const allTerminal = updatedLinks.every((l: any) => {
        const s = (l.status || '').toLowerCase();
        return s === 'done' || s === 'success' || s === 'error' || s === 'failed';
      });

      let taskStatus = 'processing';
      if (allTerminal) {
        const anySuccess = updatedLinks.some((l: any) => {
          const s = (l.status || '').toLowerCase();
          return s === 'done' || s === 'success';
        });
        taskStatus = anySuccess ? 'completed' : 'failed';
      }

      transaction.update(taskRef, {
        status: taskStatus,
        links: updatedLinks,
        ...(allTerminal ? { completedAt: new Date().toISOString() } : {}),
      });
    });

    console.log(`[Firebase] ✅ Link #${linkIdx} (${result.status}) saved to task ${taskId}`);
  } catch (dbErr: any) {
    // Non-fatal: SSE already sent the result to the client.
    console.error(`[Firebase] ❌ Link #${linkIdx} save failed:`, dbErr.message);
  }
}

export async function POST(req: Request) {
  let links: any[];
  let taskId: string | undefined;

  try {
    const body = await req.json();
    links = body.links;
    taskId = body.taskId;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!Array.isArray(links) || links.length === 0) {
    return new Response(JSON.stringify({ error: 'No links provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: any) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
        } catch {
          // Stream may have been closed by client
        }
      };

      const processLink = async (linkData: any, idx: number) => {
        const lid = linkData.id ?? idx;
        let currentLink = linkData.link;
        const logs: { msg: string; type: string }[] = [];

        const sendLog = (msg: string, type: string = 'info') => {
          logs.push({ msg, type });
          send({ id: lid, msg, type });
        };

        const fetchWithUA = (url: string, options: any = {}) => {
          return fetch(url, {
            ...options,
            headers: {
              ...options.headers,
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });
        };

        // =================================================================
        // finishLink: Send SSE terminal event + save to Firebase immediately
        // This is the core fix — every link saves independently.
        // =================================================================
        const finishLink = async (result: any) => {
          if (result.status === 'done') {
            send({ id: lid, final: result.finalLink, status: 'done' });
          } else {
            send({ id: lid, status: 'error', msg: result.error || 'Failed' });
          }

          // IMMEDIATELY persist to Firebase — don't wait for other links
          if (taskId) {
            await persistSingleLinkToFirebase(taskId, lid, { ...result, logs });
          }
        };

        try {
          sendLog('\uD83D\uDD0D Analyzing Link...', 'info');

          // Guard against missing/empty link
          if (!currentLink || typeof currentLink !== 'string') {
            sendLog('\u274C No link URL provided for this item', 'error');
            await finishLink({ status: 'error', error: 'No link URL' });
            return;
          }

          // --- HUBCDN.FANS BYPASS ---
          if (currentLink.includes('hubcdn.fans')) {
            sendLog('\u26A1 HubCDN Detected! Processing...', 'info');
            try {
              const r = await solveHubCDN(currentLink);
              if (r.status === 'success') {
                sendLog('\uD83C\uDF89 COMPLETED: Direct Link Found', 'success');
                await finishLink({ status: 'done', finalLink: r.final_link });
                return;
              } else throw new Error(r.message || 'HubCDN Native Failed');
            } catch (e: any) {
              sendLog(`\u274C HubCDN Error: ${e.message}`, 'error');
              await finishLink({ status: 'error', error: e.message });
              return;
            }
          }

          // --- TIMER BYPASS ---
          const targetDomains = ['hblinks', 'hubdrive', 'hubcdn', 'hubcloud'];
          let loopCount = 0;

          while (loopCount < 3 && !targetDomains.some((d) => currentLink.includes(d))) {
            const isTimerPage = ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'].some((x) =>
              currentLink.includes(x)
            );
            if (!isTimerPage && loopCount === 0) break;

            if (loopCount > 0) {
              sendLog('\uD83D\uDD04 Bypassing intermediate page: ' + currentLink, 'warn');
            } else {
              sendLog('\u23F3 Timer Detected. Processing...', 'warn');
            }

            try {
              sendLog('\u23F3 Calling External Timer API...', 'warn');
              const r = await fetchWithUA(API_MAP.timer + encodeURIComponent(currentLink)).then(
                (res) => res.json()
              );

              if (r.status === 'success') {
                currentLink = r.extracted_link!;
                sendLog('\u2705 Timer Bypassed', 'success');
                sendLog('\uD83D\uDD17 Link after Timer: ' + currentLink, 'info');
              } else {
                throw new Error(r.message || 'External Timer API returned failure status');
              }
            } catch (e: any) {
              sendLog(`\u274C Timer Error: ${e.message}`, 'error');
              break;
            }

            loopCount++;
          }

          // --- HBLINKS ---
          if (currentLink.includes('hblinks')) {
            sendLog('\uD83D\uDD17 Solving HBLinks (Native)...', 'info');
            try {
              const r = await solveHBLinks(currentLink);
              if (r.status === 'success') {
                currentLink = r.link!;
                sendLog('\u2705 HBLinks Solved', 'success');
              } else throw new Error(r.message || 'HBLinks Native Failed');
            } catch (e: any) {
              sendLog(`\u274C HBLinks Error: ${e.message}`, 'error');
              await finishLink({ status: 'error', error: e.message });
              return;
            }
          }

          // --- HUBDRIVE ---
          if (currentLink.includes('hubdrive')) {
            sendLog('\u2601\uFE0F Solving HubDrive (Native)...', 'info');
            try {
              const r = await solveHubDrive(currentLink);
              if (r.status === 'success') {
                currentLink = r.link!;
                sendLog('\u2705 HubDrive Solved', 'success');
                sendLog('\uD83D\uDD17 Link after HubDrive: ' + currentLink, 'info');
              } else throw new Error(r.message || 'HubDrive Native Failed');
            } catch (e: any) {
              sendLog(`\u274C HubDrive Error: ${e.message}`, 'error');
              await finishLink({ status: 'error', error: e.message });
              return;
            }
          }

          // --- HUBCLOUD (FINAL) — NATIVE SOLVER ---
          if (currentLink.includes('hubcloud') || currentLink.includes('hubcdn')) {
            sendLog('\u26A1 Getting Direct Link (Native HubCloud)...', 'info');
            try {
              const r = await solveHubCloudNative(currentLink);

              if (r.status === 'success' && r.best_download_link) {
                sendLog(`\uD83C\uDF89 COMPLETED via ${r.best_button_name || 'Best Button'}`, 'success');
                await finishLink({
                  status: 'done',
                  finalLink: r.best_download_link,
                  best_button_name: r.best_button_name || null,
                  all_available_buttons: r.all_available_buttons || [],
                });
                return;
              } else {
                throw new Error(r.message || 'HubCloud Native: No download link found');
              }
            } catch (e: any) {
              sendLog(`\u274C HubCloud Error: ${e.message}`, 'error');
              await finishLink({ status: 'error', error: e.message });
              return;
            }
          }

          // --- FINAL FALLBACK: genuinely unrecognized link ---
          sendLog('\u274C Unrecognized link format', 'error');
          await finishLink({ status: 'error', error: 'Unrecognized link format' });

        } catch (e: any) {
          sendLog(`\u26A0\uFE0F Critical Error: ${e.message}`, 'error');
          await finishLink({ status: 'error', error: e.message });
        } finally {
          send({ id: lid, status: 'finished' });
        }
      };

      // Process all links concurrently — each saves to Firebase independently
      await Promise.all(links.map((link: any, idx: number) => processLink(link, idx)));

      // No batch Firebase write needed — each link already saved itself above.
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

import { useEffect, useState, useRef, useCallback } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "convex_generated/api";

export type SandboxStatus = "idle" | "starting" | "ready" | "error";

export function useSandbox(sessionId: string | undefined) {
  const [status, setStatus] = useState<SandboxStatus>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const launchSandbox = useAction(api.actions.sandbox.launchSandbox);
  const session = useQuery(api.database.sessions.getSession, sessionId ? { sessionId, includeContext: false } : "skip");
  const insertSnapshot = useMutation(api.database.whiteboard.insertSnapshot);

  const waitForHealth = useCallback(async (baseUrl: string) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const json: any = await res.json();
          if (json && json.ok) return true;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }, []);

  useEffect(() => {
    if (!sessionId || session === undefined) return;
    if (session === null) { setStatus("error"); return; }

    if (session.sandbox_url) {
      (async () => {
        if (status === "idle") setStatus("starting");
        const healthy = await waitForHealth(session.sandbox_url);
        if (healthy) { setUrl(session.sandbox_url); setStatus("ready"); }
      })();
      return;
    }

    if (status === "idle") {
      (async () => {
        try {
          setStatus("starting");
          const resp = await launchSandbox({ sessionId });
          const healthy = await waitForHealth(resp.url);
          if (healthy) { setUrl(resp.url); setStatus("ready"); }
        } catch (err) { console.error("Sandbox launch failed", err); setStatus("error"); }
      })();
    }
  }, [sessionId, session, status, launchSandbox, waitForHealth]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [convexUrl, setConvexUrl] = useState<string | undefined>(process.env.NEXT_PUBLIC_CONVEX_URL);

  useEffect(() => {
    if (convexUrl !== undefined) return;
    fetch("/api/convex-url").then(res=>res.json()).then(j=>{ if(j?.convexUrl) setConvexUrl(j.convexUrl as string);}).catch(()=>{});
  }, [convexUrl]);

  const handleMessage = useCallback(async (ev: MessageEvent) => {
    if (!url) return;
    const data = ev.data;
    if (data?.ns !== "ai-tutor/wb") return;

    if (data.type === "ready") {
      try {
        const originUrl = new URL(url);
        const { getAuthToken } = await import("@/lib/authToken");
        iframeRef.current?.contentWindow?.postMessage({ ns:"ai-tutor/wb", v:1, type:"init", payload:{ sessionId, convexUrl, token:getAuthToken() } }, originUrl.origin);
      } catch {}
      setStatus("ready");
      return;
    }
    if (data.type === "snapshot") {
      if (!sessionId) return;
      const { payload } = data;
      const idx = payload?.index ?? 0;
      const objs = payload?.objects ?? [];
      insertSnapshot({ sessionId, snapshotIndex: idx, actionsJson: JSON.stringify(objs) }).catch(err=>console.error("Snapshot insert failed",err));
    }
  }, [url, sessionId, convexUrl, insertSnapshot]);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  const jumpToSnapshot = useCallback((index: number, objects: any[]) => {
    if(!url || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage({ ns:"ai-tutor/wb", v:1, type:"jump", payload:{ index, objects } });
  }, [url]);

  useEffect(()=>{
    if(!url || !iframeRef.current || !convexUrl || !sessionId) return;
    const id = setInterval(async ()=>{
      try {
        const { getAuthToken } = await import("@/lib/authToken");
        iframeRef.current?.contentWindow?.postMessage({ ns:"ai-tutor/wb", v:1, type:"init", payload:{ sessionId, convexUrl, token:getAuthToken() } }, "*");
      } catch {}
    }, 2000);
    return ()=> clearInterval(id);
  }, [url, convexUrl, sessionId]);

  return { url, status, iframeRef, retry: () => setStatus("idle"), jumpToSnapshot } as const;
} 
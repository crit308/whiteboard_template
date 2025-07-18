"use client";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// NEW WHITEBOARD CANVAS IMPLEMENTATION WITH CONVEX INTEGRATION
import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
  useMemo,
} from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient, ConvexProvider, useQuery as convexUseQuery, useMutation as convexUseMutation } from "convex/react";

// `fabric` does not ship proper ESM types yet, so we rely on dynamic import
let fabric: any; // will be assigned on the client only

// Type helpers --------------------------------------------------------------
interface WBRectSpec {
  id: string;
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  metadata?: Record<string, any>;
}

interface WBInkSpec {
  id: string;
  kind: "ink";
  d: string; // SVG path string
  stroke?: string;
  width?: number;
  metadata?: Record<string, any>;
}

interface WBEllipseSpec {
  id: string;
  kind: "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  metadata?: Record<string, any>;
}

interface WBArrowSpec {
  id: string;
  kind: "arrow";
  x: number;
  y: number;
  points: number[][]; // relative points
  stroke?: string;
  strokeWidth?: number;
  arrowType?: string;
  metadata?: Record<string, any>;
}

interface WBWidgetSpec {
  id: string;
  kind: "widget";
  entry: string;
  props?: Record<string, any>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  metadata?: Record<string, any>;
}

interface WBLineSpec {
  id: string;
  kind: "line";
  x: number;
  y: number;
  points: number[][];
  stroke?: string;
  strokeWidth?: number;
  metadata?: Record<string, any>;
}

interface WBTextSpec {
  id: string;
  kind: "text";
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  fill?: string;
  metadata?: Record<string, any>;
}

type WBObjectSpec = WBInkSpec | WBRectSpec | WBEllipseSpec | WBArrowSpec | WBLineSpec | WBTextSpec | WBWidgetSpec;

declare global {
  interface Window {
    whiteboard?: {
      addInk: (points: number[][]) => void;
      addShape: (kind: string, spec: any) => void;
      updateObject: (id: string, patch: any) => void;
      deleteObject: (id: string) => void;
    };
  }
}

// Canvas constants ----------------------------------------------------------
const CANVAS_ID = "sandbox-whiteboard-canvas";

// Utility: naive id generator (crypto.randomUUID poly-fill) ------------------
const genId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
export default function WhiteboardCanvas() {
  // After parent iframe sends "init", we store session + Convex info.
  const [init, setInit] = useState<
    | { sessionId: string; convexUrl: string; token?: string }
    | null
  >(null);

  // Convex client – lazily instantiated once we have init payload
  const convexClientRef = useRef<ConvexReactClient | null>(null);

  // Listen for messages from parent ------------------------------------------------
  const handleMessage = useCallback((ev: MessageEvent) => {
    if (!ev.data || ev.data.ns !== "ai-tutor/wb") return;
    if (ev.data.type === "init" && ev.data.payload?.sessionId) {
      const { sessionId, convexUrl, token } = ev.data.payload;
      if (!convexUrl) {
        console.error("[Whiteboard] Missing convexUrl in init payload");
        return;
      }
      setInit({ sessionId, convexUrl, token });
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Instantiate Convex client once --------------------------------------------------
  useEffect(() => {
    if (!init || convexClientRef.current) return;
    const client = new ConvexReactClient(init.convexUrl);
    if (init.token) {
      client.setAuth(async () => init.token as string, () => {});
    }
    convexClientRef.current = client;
  }, [init]);

  // Notify parent that iframe is ready (once)
  useEffect(() => {
    try {
      window.parent?.postMessage({ ns: "ai-tutor/wb", v: 1, type: "ready" }, "*");
    } catch (_) {}
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      {(!init || !convexClientRef.current) ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
          Connecting …
        </div>
      ) : (
        <ConvexProvider client={convexClientRef.current}>
          <InnerWhiteboard sessionId={init.sessionId} />
        </ConvexProvider>
      )}
    </div>
  );
}

// =============================================================================
// Inner whiteboard component: sets up Fabric + realtime Convex sync
// =============================================================================
function InnerWhiteboard({ sessionId }: { sessionId: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fabricCanvasRef = useRef<any | null>(null);
  const widgetLayerRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<any[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const [isHistoryMode, setIsHistoryMode] = useState(false);
  const [historyBanner, setHistoryBanner] = useState(false);
  const snapshotIntervalRef = useRef<number | null>(null);

  // Snapshot tracking
  const mutationCounterRef = useRef(0);
  const lastSnapshotTsRef = useRef(Date.now());

  // Convex helpers -----------------------------------------------------------
  // We avoid importing generated API types; string paths work fine.
  const addObject = (0 as any) as ReturnType<typeof useCallback>; // placeholder to satisfy TS prior to dynamic assignment

  // Use Convex React hooks directly (single React instance)
  const useQuery = convexUseQuery;
  const useMutation = convexUseMutation;

  const objects: WBObjectSpec[] | undefined = useQuery(
    "database/whiteboard:getWhiteboardObjects" as any,
    { sessionId },
  );

  const addWhiteboardObject = useMutation(
    "database/whiteboard:addWhiteboardObject" as any,
  );

  const updateWhiteboardObject = useMutation(
    "database/whiteboard:updateWhiteboardObject" as any,
  );

  const deleteWhiteboardObject = useMutation(
    "database/whiteboard:deleteWhiteboardObject" as any,
  );

  // Helper to record history snapshot
  const pushHistory = useCallback(() => {
    if (!fabricCanvasRef.current) return;
    const json = fabricCanvasRef.current.toJSON(["selectable"]);
    const h = historyRef.current;
    // Keep recent 50 snapshots
    if (h.length >= 50) h.shift();
    h.push(json.objects as any);
    historyIndexRef.current = h.length - 1;
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!fabricCanvasRef.current || historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    fabricCanvasRef.current.loadFromJSON({ objects: h[historyIndexRef.current] }, () => {
      fabricCanvasRef.current!.renderAll();
    });
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (
      !fabricCanvasRef.current ||
      historyIndexRef.current >= h.length - 1
    )
      return;
    historyIndexRef.current += 1;
    fabricCanvasRef.current.loadFromJSON({ objects: h[historyIndexRef.current] }, () => {
      fabricCanvasRef.current!.renderAll();
    });
  }, []);

  // --------------------- Fabric initialisation -----------------------------
  useEffect(() => {
    const initFabric = async () => {
      if (!canvasRef.current || !containerRef.current) return;
      if (!fabric) {
        const mod: any = await import("fabric");
        fabric = mod.fabric ?? mod;
      }

      const parentRect = containerRef.current.getBoundingClientRect();
      const fabricCanvas = new fabric.Canvas(canvasRef.current, {
        selection: false,
        backgroundColor: "#ffffff",
        width: parentRect.width,
        height: parentRect.height,
      });
      fabricCanvas.isDrawingMode = false;

      fabricCanvasRef.current = fabricCanvas;

      // Record initial blank state
      pushHistory();

      // Disable user-driven modifications; no path creation or object modification listeners

      // Expose helper API for AI / parent window ---------------------------
      window.whiteboard = {
        addInk: async (points) => {
          // Very naive SVG generation from point pairs
          if (!points || points.length === 0) return;
          const d = points
            .map((p, idx) => `${idx === 0 ? "M" : "L"} ${p[0]} ${p[1]}`)
            .join(" ");
          const spec: WBInkSpec = {
            id: genId(),
            kind: "ink",
            d,
          };
          await addWhiteboardObject({ sessionId, objectSpec: spec });
        },
        addShape: async (kind, spec) => {
          const id = genId();
          const baseSpec = { id, kind, ...spec } as any;
          // Basic validation: ensure required fields exist for arrow
          if (kind === "arrow") {
            if (
              spec.x1 === undefined ||
              spec.y1 === undefined ||
              spec.x2 === undefined ||
              spec.y2 === undefined
            ) {
              console.warn("addShape: arrow spec missing coords");
              return;
            }
          }
          await addWhiteboardObject({ sessionId, objectSpec: baseSpec });
        },
        updateObject: async (id, patch) => {
          await updateWhiteboardObject({ sessionId, objectId: id, objectSpec: patch });
        },
        deleteObject: async (id) => {
          await deleteWhiteboardObject({ sessionId, objectId: id });
        },
      };

      // Interval snapshot every 60s (ensure single timer)
      if (snapshotIntervalRef.current !== null) clearInterval(snapshotIntervalRef.current);
      snapshotIntervalRef.current = window.setInterval(() => {
        if (Date.now() - lastSnapshotTsRef.current >= 60000 || mutationCounterRef.current >= 20) {
          if (!fabricCanvasRef.current) return;
          const objectsJson = fabricCanvasRef.current.toJSON(["selectable"]).objects as any;
          window.parent?.postMessage({ ns:"ai-tutor/wb", type:"snapshot", payload:{ index: Date.now(), objects: objectsJson }}, "*");
          mutationCounterRef.current = 0;
          lastSnapshotTsRef.current = Date.now();
        }
      }, 5000);

      // Resize on window resize
      const handleResize = () => {
        const rect = containerRef.current!.getBoundingClientRect();
        fabricCanvas.setWidth(rect.width);
        fabricCanvas.setHeight(rect.height);
        fabricCanvas.requestRenderAll();
      };
      window.addEventListener("resize", handleResize);
    };

    initFabric();

    return () => {
      if (fabricCanvasRef.current) {
        fabricCanvasRef.current.dispose();
      }
    };
  }, [sessionId, addWhiteboardObject, updateWhiteboardObject, deleteWhiteboardObject]);

  // Cleanup snapshot timer on unmount
  useEffect(() => {
    return () => {
      if (snapshotIntervalRef.current !== null) clearInterval(snapshotIntervalRef.current);
    };
  }, []);

  // -------------- Sync inbound Convex objects to Fabric -------------------
  useEffect(() => {
    if (!fabricCanvasRef.current || objects === undefined) return;

    const canvas = fabricCanvasRef.current;

    // For MVP, clear and redraw all objects on each update.
    // Background color is lost on clear, so we restore.
    const bgColor = canvas.backgroundColor;
    canvas.clear();
    canvas.setBackgroundColor(bgColor, () => {});

    // Clear widget layer
    if (widgetLayerRef.current) {
      widgetLayerRef.current.innerHTML = "";
    }

    for (const obj of objects as any[]) {
      if (obj.kind === "ink") {
        const path = new fabric.Path(obj.d, {
          stroke: obj.stroke || "#000000",
          strokeWidth: obj.width || 2,
          fill: "",
          selectable: false,
        });
        (path as any).metadata = { id: obj.id };
        canvas.add(path);
      }
      else if (obj.kind === "rect") {
        const rect = new fabric.Rect({
          left: (obj as any).x,
          top: (obj as any).y,
          width: (obj as any).width,
          height: (obj as any).height,
          fill: (obj as any).fill ?? "",
          stroke: (obj as any).stroke ?? "#000000",
          selectable: false,
        });
        (rect as any).metadata = { id: obj.id };
        canvas.add(rect);
      }
      else if (obj.kind === "ellipse") {
        // Adapt to WB schema: x,y refer to top-left of bounding box; width/height are diameters
        const left = (obj as any).x;
        const top = (obj as any).y;
        const width = (obj as any).width ?? 0;
        const height = (obj as any).height ?? 0;
        const ellipse = new fabric.Ellipse({
          left,
          top,
          rx: width / 2,
          ry: height / 2,
          fill: (obj as any).fill ?? "",
          stroke: (obj as any).stroke ?? "#000000",
          selectable: false,
        });
        (ellipse as any).metadata = { id: obj.id };
        canvas.add(ellipse);
      }
      else if (obj.kind === "line") {
        const { x, y, points, stroke, strokeWidth } = obj as any;
        if (Array.isArray(points) && points.length >= 2) {
          const absPts = points.map(([px, py]: number[]) => [x + px, y + py]);
          const [p0, p1] = [absPts[0], absPts[absPts.length - 1]];
          const line = new fabric.Line([p0[0], p0[1], p1[0], p1[1]], {
            stroke: stroke ?? "#000000",
            strokeWidth: strokeWidth ?? 2,
            selectable: false,
          });
          (line as any).metadata = { id: obj.id };
          canvas.add(line);
        }
      }
      else if (obj.kind === "arrow") {
        const { x, y, points, stroke, strokeWidth } = obj as any;
        if (Array.isArray(points) && points.length >= 2) {
          const absPts = points.map(([px, py]: number[]) => [x + px, y + py]);
          const [start, end] = [absPts[0], absPts[absPts.length - 1]];
          // main line
          const mainLine = new fabric.Line([start[0], start[1], end[0], end[1]], {
            stroke: stroke ?? "#000000",
            strokeWidth: strokeWidth ?? 2,
            selectable: false,
          });
          // arrow head
          const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
          const headLen = 10;
          const p1x = end[0] - headLen * Math.cos(angle - Math.PI / 6);
          const p1y = end[1] - headLen * Math.sin(angle - Math.PI / 6);
          const p2x = end[0] - headLen * Math.cos(angle + Math.PI / 6);
          const p2y = end[1] - headLen * Math.sin(angle + Math.PI / 6);
          const head = new fabric.Polygon([
            { x: end[0], y: end[1] },
            { x: p1x, y: p1y },
            { x: p2x, y: p2y },
          ], {
            fill: stroke ?? "#000000",
            selectable: false,
          });
          const group = new fabric.Group([mainLine, head], { selectable: false });
          (group as any).metadata = { id: obj.id };
          canvas.add(group);
        }
      }
      else if (obj.kind === "text") {
        const { x, y, text, fontSize, fill } = obj as any;
        const textbox = new fabric.Textbox(text || "", {
          left: x,
          top: y,
          fontSize: fontSize ?? 16,
          fill: fill ?? "#000000",
          selectable: false,
        });
        (textbox as any).metadata = { id: obj.id };
        canvas.add(textbox);
      }
      else if (obj.kind === "widget") {
        if (!widgetLayerRef.current) continue;

        const { x = 0, y = 0, width = 120, height = 60, entry, props = "{}", version = 1 } = (obj as any);
        const widgetProps = (() => { try { return JSON.parse(props as any); } catch { return {}; } })();

        const host = document.createElement("div");
        host.style.position = "absolute";
        host.style.left = `${x}px`;
        host.style.top = `${y}px`;
        host.style.width = `${width}px`;
        host.style.height = `${height}px`;
        host.style.pointerEvents = "auto";
        widgetLayerRef.current.appendChild(host);

        const root = ReactDOM.createRoot(host);

        const LazyWidget = React.lazy(() => import(/* @vite-ignore */ `/app/widgets/${encodeURIComponent(entry)}/client.js?ver=${version}`));

        root.render(
          <ErrorBoundary>
            <React.Suspense fallback={<div style={{fontSize:12}}>…</div>}>
              <LazyWidget {...widgetProps} />
            </React.Suspense>
          </ErrorBoundary>
        );
      }
    }

    canvas.requestRenderAll();

    // Each inbound refresh counts as new state baseline in history
    pushHistory();
  }, [objects]);

  // ---------------- Parent commands listener ------------------------------
  useEffect(() => {
    const cmdListener = (ev: MessageEvent) => {
      if (!ev.data || ev.data.ns !== "ai-tutor/wb") return;

      if (ev.data.type === "command") {
        const action = ev.data.payload?.action;
        if (action === "undo") undo();
        else if (action === "redo") redo();
        else if (action === "setZoom") {
          const zoom = ev.data.payload?.args?.zoom ?? 1;
          if (fabricCanvasRef.current) {
            fabricCanvasRef.current.setZoom(zoom);
          }
        }
      } else if (ev.data.type === "jump") {
        const { objects } = ev.data.payload ?? {};
        if (!objects) return;
        const fc = fabricCanvasRef.current;
        if (!fc) return;
        setIsHistoryMode(true);
        setHistoryBanner(true);
        fc.evented = false;
        fc.selection = false;
        fc.loadFromJSON({ objects }, () => {
          fc.renderAll();
        });
      }
    };
    window.addEventListener("message", cmdListener);
    return () => window.removeEventListener("message", cmdListener);
  }, [undo, redo]);

  // ---------------- UI -----------------------------------------------------
  return (
    <div ref={containerRef} style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <canvas id={CANVAS_ID} ref={canvasRef} style={{ border: "1px solid #e5e7eb", width: "100%", height: "100%" }} />
      <div ref={widgetLayerRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
      {historyBanner && (
        <div
          style={{position:"absolute",top:10,left:"50%",transform:"translateX(-50%)",background:"#f5f5f5",padding:"6px 12px",borderRadius:4,border:"1px solid #ccc",cursor:"pointer"}}
          onClick={() => {
            const fc = fabricCanvasRef.current;
            if (fc) {
              fc.evented = true;
              fc.selection = true;
            }
            setIsHistoryMode(false);
            setHistoryBanner(false);
          }}
        >
          Viewing history – click to return to live
        </div>
      )}
    </div>
  );
}

// ---------------- ErrorBoundary -----------------------------
class ErrorBoundary extends React.Component<{ fallback?: React.ReactNode; children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false } as any;
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: any, info: any) {
    // Emit error to parent Tutor for potential self-healing
    try {
      window.parent?.postMessage({ ns: "ai-tutor/wb", v: 1, type: "widget-error", payload: { error: String(error), info } }, "*");
    } catch {}
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback || <div style={{ fontSize: 12, color: "#f00" }}>⚠️ widget error</div>;
    }
    return this.props.children;
  }
} 
"use client";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-require-imports, react-hooks/rules-of-hooks, react-hooks/exhaustive-deps */
// NEW WHITEBOARD CANVAS IMPLEMENTATION WITH CONVEX INTEGRATION
import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
  useMemo,
} from "react";
import { ConvexReactClient, ConvexProvider } from "convex/react";

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
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  fill?: string;
  stroke?: string;
  metadata?: Record<string, any>;
}

interface WBArrowSpec {
  id: string;
  kind: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color?: string;
  width?: number;
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

type WBObjectSpec = WBInkSpec | WBRectSpec | WBEllipseSpec | WBArrowSpec | WBWidgetSpec;

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

  // While waiting for handshake, show placeholder
  if (!init || !convexClientRef.current) {
    return (
      <div style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        Connecting …
      </div>
    );
  }

  useEffect(() => {
    // Notify parent that iframe is ready for init handshake
    try {
      window.parent?.postMessage({ ns: "ai-tutor/wb", v: 1, type: "ready" }, "*");
    } catch (_) {}
  }, []);

  return (
    <ConvexProvider client={convexClientRef.current}>
      <InnerWhiteboard sessionId={init.sessionId} />
    </ConvexProvider>
  );
}

// =============================================================================
// Inner whiteboard component: sets up Fabric + realtime Convex sync
// =============================================================================
function InnerWhiteboard({ sessionId }: { sessionId: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const addObject = (0 as any) as ReturnType<typeof useCallback>; // placeholder to satisfy TS prior to dynamic assignment

  // Lazy-import Convex React hooks (avoid ESM in sandbox build)
  const loadConvexHooks = () => {
    // dynamic require to ensure proper top-level order
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useQuery, useMutation } = require("convex/react");
    return { useQuery, useMutation } as {
      useQuery: typeof import("convex/react").useQuery;
      useMutation: typeof import("convex/react").useMutation;
    };
  };

  const { useQuery, useMutation } = useMemo(() => loadConvexHooks(), []);

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
      if (!canvasRef.current) return;
      if (!fabric) {
        const mod: any = await import("fabric");
        fabric = mod.fabric ?? mod;
      }

      const fabricCanvas = new fabric.Canvas(canvasRef.current, {
        selection: true,
        backgroundColor: "#ffffff",
      });
      fabricCanvas.isDrawingMode = true;
      fabricCanvas.freeDrawingBrush.color = "#000000";
      fabricCanvas.freeDrawingBrush.width = 2;

      fabricCanvasRef.current = fabricCanvas;

      // Record initial blank state
      pushHistory();

      // Outbound: when user finishes drawing, create object in Convex
      fabricCanvas.on("path:created", async (evt: any) => {
        const pathObj = evt.path as any;
        if (!pathObj) return;

        const svg = pathObj.toSVG?.() ?? "";
        // Extract d attribute from <path d="..." />
        const match = svg.match(/d=\"([^\"]+)\"/);
        const d = match ? match[1] : "";

        const spec: WBInkSpec = {
          id: genId(),
          kind: "ink",
          d,
          stroke: pathObj.stroke,
          width: pathObj.strokeWidth,
        };

        try {
          await addWhiteboardObject({ sessionId, objectSpec: spec });

          mutationCounterRef.current += 1;
         
          // Send lightweight snapshot of current objects to parent for history
          try {
            const objectsJson = fabricCanvas.toJSON(["selectable"]).objects as any;
            window.parent?.postMessage(
              {
                ns: "ai-tutor/wb",
                type: "snapshot",
                payload: {
                  index: Date.now(),
                  objects: objectsJson,
                },
              },
              "*",
            );
          } catch (_err) {
            // Reset counters
            mutationCounterRef.current = 0;
            lastSnapshotTsRef.current = Date.now();
          }
        } catch (err) {
          console.error("Failed to add whiteboard object", err);
        }

        pushHistory();
      });

      // Track modifications & deletions for history
      const record = () => pushHistory();
      fabricCanvas.on("object:modified", record);
      fabricCanvas.on("object:removed", record);

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

    for (const obj of objects) {
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
        const ellipse = new fabric.Ellipse({
          left: (obj as any).cx - (obj as any).rx,
          top: (obj as any).cy - (obj as any).ry,
          rx: (obj as any).rx,
          ry: (obj as any).ry,
          fill: (obj as any).fill ?? "",
          stroke: (obj as any).stroke ?? "#000000",
          selectable: false,
        });
        (ellipse as any).metadata = { id: obj.id };
        canvas.add(ellipse);
      }
      else if (obj.kind === "widget") {
        // Create HTML overlay
        if (!widgetLayerRef.current) continue;
        const div = document.createElement("div");
        div.style.position = "absolute";
        const { x = 0, y = 0, width = 120, height = 60 } = (obj as any);
        div.style.left = `${x}px`;
        div.style.top = `${y}px`;
        div.style.width = `${width}px`;
        div.style.height = `${height}px`;
        div.style.pointerEvents = "auto";
        div.style.display = "flex";
        div.style.alignItems = "center";
        div.style.justifyContent = "center";
        div.style.backgroundColor = "rgba(255,255,255,0.8)";
        div.style.border = "1px dashed #888";
        div.innerText = `Widget: ${(obj as any).entry || "unknown"}`;
        widgetLayerRef.current.appendChild(div);
      }
      else if (obj.kind === "arrow") {
        const { x1, y1, x2, y2, color, width } = obj as WBArrowSpec;
        const line = new fabric.Line([x1, y1, x2, y2], {
          stroke: color ?? "#000000",
          strokeWidth: width ?? 2,
          selectable: false,
        });
        // triangle head
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 10;
        const p1x = x2 - headLen * Math.cos(angle - Math.PI / 6);
        const p1y = y2 - headLen * Math.sin(angle - Math.PI / 6);
        const p2x = x2 - headLen * Math.cos(angle + Math.PI / 6);
        const p2y = y2 - headLen * Math.sin(angle + Math.PI / 6);
        const triangle = new fabric.Polygon([
          { x: x2, y: y2 },
          { x: p1x, y: p1y },
          { x: p2x, y: p2y },
        ], {
          fill: color ?? "#000000",
          selectable: false,
        });
        const group = new fabric.Group([line, triangle], { selectable:false });
        (group as any).metadata = { id: obj.id };
        canvas.add(group);
      }
      // TODO: handle other kinds
    }

    canvas.requestRenderAll();

    // Each inbound refresh counts as new state baseline in history
    pushHistory();
  }, [objects]);

  // ---------------- Parent commands listener ------------------------------
  useEffect(() => {
    const cmdListener = (ev: MessageEvent) => {
      if (!ev.data || ev.data.ns !== "ai-tutor/wb" || ev.data.type !== "command") return;
      const action = ev.data.payload?.action;
        if (action === "undo") undo();
        else if (action === "redo") redo();
        else if (action === "setZoom") {
        const zoom = ev.data.payload?.args?.zoom ?? 1;
        if (fabricCanvasRef.current) {
          fabricCanvasRef.current.setZoom(zoom);
        }
      }
      else if (ev.data.type === "jump") {
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
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <canvas id={CANVAS_ID} ref={canvasRef} style={{ border: "1px solid #e5e7eb" }} />
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
"use client";
import React, { useEffect, useRef, useCallback } from "react";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { fabric } from "fabric";

const CANVAS_ID = "sandbox-whiteboard-canvas";

export default function WhiteboardCanvas() {
  const fabricRef = useRef<any | null>(null);
  const historyRef = useRef<any[]>([]);
  const historyIndexRef = useRef<number>(-1);

  // Helpers
  const pushHistory = () => {
    if (!fabricRef.current) return;
    const json = fabricRef.current.toJSON(["selectable"]);
    const h = historyRef.current;
    if (h.length >= 50) h.shift();
    h.push(json.objects as any);
    historyIndexRef.current = h.length - 1;
    // Send snapshot to parent window
    try {
      window.parent?.postMessage(
        {
          ns: "ai-tutor/wb",
          type: "snapshot",
          payload: {
            index: historyIndexRef.current,
            objects: h[historyIndexRef.current],
          },
        },
        "*",
      );
    } catch (_) {}
  };

  const undo = () => {
    const h = historyRef.current;
    if (!fabricRef.current || historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    fabricRef.current.loadFromJSON({ objects: h[historyIndexRef.current] }, () => {
      fabricRef.current!.renderAll();
    });
  };

  const redo = () => {
    const h = historyRef.current;
    if (!fabricRef.current || historyIndexRef.current >= h.length - 1) return;
    historyIndexRef.current += 1;
    fabricRef.current.loadFromJSON({ objects: h[historyIndexRef.current] }, () => {
      fabricRef.current!.renderAll();
    });
  };

  // Initialize canvas
  useEffect(() => {
    const canvasEl = document.getElementById(CANVAS_ID) as HTMLCanvasElement;
    if (!canvasEl) return;

    const fabricCanvas = new fabric.Canvas(canvasEl, {
      selection: true,
      backgroundColor: "#ffffff",
    });
    fabricRef.current = fabricCanvas;

    // Enable free drawing by default
    fabricCanvas.isDrawingMode = true;
    fabricCanvas.freeDrawingBrush.color = "#000000";
    fabricCanvas.freeDrawingBrush.width = 2;

    // Push first history state
    pushHistory();

    // Record history on object addition/modification
    const record = () => pushHistory();
    fabricCanvas.on("path:created", record);
    fabricCanvas.on("object:modified", record);

    // Cleanup
    return () => {
      fabricCanvas.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Message listener for commands from parent iframe
  const handleMessage = useCallback((ev: MessageEvent) => {
    if (!ev.data || ev.data.ns !== "ai-tutor/wb") return;
    const { type, payload } = ev.data;
    switch (type) {
      case "command": {
        const action = payload?.action as string;
        if (action === "undo") undo();
        else if (action === "redo") redo();
        else if (action === "setZoom") {
          const zoom = payload?.args?.zoom ?? 1;
          if (fabricRef.current) {
            fabricRef.current.setZoom(zoom);
          }
        }
        break;
      }
      default:
        break;
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <canvas id={CANVAS_ID} style={{ border: "1px solid #e5e7eb" }} />
    </div>
  );
} 
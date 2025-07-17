"use client";
import { useEffect } from "react";

export default function WhiteboardPlaceholder() {
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.parent?.postMessage({ ns: "ai-tutor/wb", type: "ready" }, "*");
    }
  }, []);

  return (
    <main
      style={{
        display: "flex",
        height: "100vh",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "sans-serif",
      }}
    >
      <h1>Sandbox Whiteboard – template repo</h1>
    </main>
  );
}

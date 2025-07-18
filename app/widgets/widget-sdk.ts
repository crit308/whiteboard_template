"use client";

// Widgets should import React normally (`import React, { useState } from "react"`).
// We only provide helper utilities here.

// Convex React hooks (runtime safe)
export { useQuery, useMutation } from "convex/react";

// Helper to notify the Tutor agent of an event inside the widget
export function tutorEvent(type: string, payload?: any) {
  if (typeof window !== "undefined") {
    try {
      window.parent?.postMessage({ ns: "ai-tutor/wb", v: 1, type, payload }, "*");
    } catch {}
  }
} 
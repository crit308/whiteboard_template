"use client";
import dynamic from "next/dynamic";
import { useEffect } from "react";

// Dynamically import Fabric canvas component only on client side
const WhiteboardCanvas = dynamic(() => import("../components/WhiteboardCanvas"), {
  ssr: false,
});

export default function WhiteboardPage() {
  useEffect(() => {
    window.parent?.postMessage({ ns: "ai-tutor/wb", type: "ready" }, "*");
  }, []);

  return <WhiteboardCanvas />;
}

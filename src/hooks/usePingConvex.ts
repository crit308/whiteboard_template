"use client";
import { useQuery } from "convex/react";
import { api } from "convex/_generated/api"; // path resolves after convex codegen

export function usePingConvex() {
  return useQuery(api.internal.util.ping, {}); // create a trivial ping query later
} 
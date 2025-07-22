import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const run = promisify(exec);

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.OVERLAY_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { path: relPath, content } = (await req.json()) as {
    path: string;
    content: string | null;
  };
  if (!relPath || !relPath.startsWith("app/")) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  const absPath = `/app/${relPath.slice(4)}`;
  await fs.mkdir(path.dirname(absPath), { recursive: true });

  try {
    if (content === null) {
      await fs.rm(absPath, { force: true });
    } else {
      await fs.writeFile(absPath, content, "utf8");
    }
  } catch (err) {
    console.error("[overlay] file write error", err);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }

  // Widget compilation
  if (/^app\/widgets\/[^/]+\/client\.tsx$/.test(relPath)) {
    const entry = relPath.split("/")[2];
    const outDir = `/app/public/widgets/${entry}`;
    await fs.mkdir(outDir, { recursive: true });
    const cmd = `npx esbuild ${absPath} --bundle --format=esm --jsx=automatic --outfile=${outDir}/client.js`;
    try {
      const { stderr } = await run(cmd);
      if (stderr) console.error("[overlay] esbuild stderr", stderr);
    } catch (err) {
      console.error("[overlay] esbuild failed", err);
      await fs.writeFile(`${outDir}/client.js`, 'throw new Error("Widget build failed")');
    }
  }

  return NextResponse.json({ ok: true });
} 
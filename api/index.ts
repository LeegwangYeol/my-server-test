import type { IncomingMessage, ServerResponse } from "node:http";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const listDir = (dir: string, depth = 2): any => {
  try {
    const entries = readdirSync(dir);
    const out: any = {};
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          out[name + "/"] = depth > 0 ? listDir(full, depth - 1) : "...";
        } else {
          out[name] = st.size;
        }
      } catch {
        out[name] = "?";
      }
    }
    return out;
  } catch (e: any) {
    return `<err: ${e?.message}>`;
  }
};

export default function handler(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const root = "/var/task";
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      {
        cwd: process.cwd(),
        url: req.url,
        method: req.method,
        node: process.version,
        listing: {
          "/var/task": listDir(root, 2),
          "/var/task/src": listDir(join(root, "src"), 2),
          "/var/task/lib": listDir(join(root, "lib"), 2),
          "/var/task/api": listDir(join(root, "api"), 2),
        },
      },
      null,
      2,
    ),
  );
}

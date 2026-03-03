type DiffOp =
  | { type: "equal"; lines: string[] }
  | { type: "insert"; lines: string[] }
  | { type: "delete"; lines: string[] };

type Trace = Map<number, number>;

function backtrack(trace: Trace[], a: string[], b: string[]): DiffOp[] {
  let x = a.length;
  let y = b.length;
  const ops: DiffOp[] = [];

  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d] ?? new Map<number, number>();
    const k = x - y;
    const prevK =
      k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0)) ? k + 1 : k - 1;
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", lines: [a[x - 1]] });
      x -= 1;
      y -= 1;
    }

    if (d === 0) {
      break;
    }

    if (x === prevX) {
      ops.push({ type: "insert", lines: [b[y - 1]] });
      y -= 1;
    } else {
      ops.push({ type: "delete", lines: [a[x - 1]] });
      x -= 1;
    }
  }

  ops.reverse();
  return coalesceOps(ops);
}

function coalesceOps(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type) {
      last.lines.push(...op.lines);
      continue;
    }
    out.push({ type: op.type, lines: [...op.lines] } as DiffOp);
  }
  return out;
}

export function diffLines(beforeText: string, afterText: string): DiffOp[] {
  if (beforeText === afterText) {
    return [{ type: "equal", lines: beforeText.length ? beforeText.split("\n") : [""] }];
  }

  const a = beforeText.split("\n");
  const b = afterText.split("\n");
  const n = a.length;
  const m = b.length;
  const max = n + m;

  let v = new Map<number, number>();
  v.set(1, 0);
  const trace: Trace[] = [];

  for (let d = 0; d <= max; d += 1) {
    const next = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next.set(k, x);
      if (x >= n && y >= m) {
        trace.push(next);
        return backtrack(trace, a, b);
      }
    }
    trace.push(next);
    v = next;
  }

  return coalesceOps(
    [
      ...(beforeText ? [{ type: "delete", lines: beforeText.split("\n") }] : []),
      ...(afterText ? [{ type: "insert", lines: afterText.split("\n") }] : []),
    ] as DiffOp[],
  );
}

export function formatUnifiedDiff(params: {
  path: string;
  beforeText: string;
  afterText: string;
}): string {
  const ops = diffLines(params.beforeText, params.afterText);
  const lines: string[] = [];
  lines.push(`--- ${params.path}`);
  lines.push(`+++ ${params.path}`);
  lines.push("@@");
  for (const op of ops) {
    const prefix = op.type === "equal" ? " " : op.type === "insert" ? "+" : "-";
    for (const line of op.lines) {
      lines.push(`${prefix}${line}`);
    }
  }
  return lines.join("\n");
}

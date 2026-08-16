export type GameLogEntry = {
  id: string;
  timestamp: string;
  stream: "stdout" | "stderr";
  message: string;
};

export type GameProcessState =
  | { status: "idle" }
  | { status: "launching"; packId: string }
  | { status: "running"; packId: string; pid: number }
  | { status: "exited"; packId: string; exitCode: number | null; signal?: string }
  | { status: "error"; packId: string; message: string };

export function createBoundedGameEventStore(limit = 1000, now = () => new Date().toISOString()) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Invalid game log limit");
  const logs: GameLogEntry[] = [];
  const pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  let state: GameProcessState = { status: "idle" };
  let sequence = 0;
  let logHandler: ((entry: GameLogEntry) => void) | null = null;
  let stateHandler: ((value: GameProcessState) => void) | null = null;

  const pushLog = (stream: "stdout" | "stderr", message: string) => {
    const entry = { id: `game-${++sequence}`, timestamp: now(), stream, message: message.slice(0, 8192) };
    logs.push(entry);
    if (logs.length > limit) logs.splice(0, logs.length - limit);
    logHandler?.({ ...entry });
    return entry;
  };
  const acceptChunk = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
    const combined = pending[stream] + String(chunk);
    const lines = combined.split(/\r?\n/);
    pending[stream] = lines.pop() ?? "";
    for (const line of lines) if (line) pushLog(stream, line);
  };
  const flush = () => {
    for (const stream of ["stdout", "stderr"] as const) {
      if (pending[stream]) pushLog(stream, pending[stream]);
      pending[stream] = "";
    }
  };
  return {
    pushLog,
    acceptChunk,
    flush,
    getLogs: () => logs.map((entry) => ({ ...entry })),
    getState: () => ({ ...state } as GameProcessState),
    setState(value: GameProcessState) { state = { ...value }; stateHandler?.({ ...state } as GameProcessState); },
    setLogHandler(handler: typeof logHandler) { logHandler = handler; },
    setStateHandler(handler: typeof stateHandler) { stateHandler = handler; },
  };
}

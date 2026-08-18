import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

function isImageContent(value: unknown): value is ImageContent {
  if (!value || typeof value !== "object") return false;
  const block = value as Partial<ImageContent>;
  return (
    block.type === "image" &&
    typeof block.data === "string" &&
    block.data.length > 0 &&
    typeof block.mimeType === "string" &&
    IMAGE_EXTENSIONS[block.mimeType.toLowerCase()] !== undefined
  );
}

/**
 * Save images from the latest user message on the active branch as files that
 * a separately launched subagent can read. Older user-message images are not
 * included: this handoff mirrors attachments on the turn that spawned it.
 */
export function materializeLatestUserImages(
  branchEntries: Array<{ type?: string; message?: { role?: string; content?: unknown } }>,
  outputDir: string,
): string[] {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry.type !== "message" || entry.message?.role !== "user") continue;

    const content = entry.message.content;
    if (!Array.isArray(content)) return [];
    const images = content.filter(isImageContent);
    if (images.length === 0) return [];

    const absoluteOutputDir = resolve(outputDir);
    mkdirSync(absoluteOutputDir, { recursive: true, mode: 0o700 });
    return images.map((image, index) => {
      const extension = IMAGE_EXTENSIONS[image.mimeType.toLowerCase()];
      const imagePath = join(absoluteOutputDir, `image-${index + 1}.${extension}`);
      writeFileSync(imagePath, Buffer.from(image.data, "base64"), { mode: 0o600 });
      return imagePath;
    });
  }
  return [];
}

export function appendImagePathInstructions(task: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return task;
  const paths = imagePaths.map((imagePath) => `- ${imagePath}`).join("\n");
  return `${task}\n\nImages attached to the current main-session user message are available at these absolute paths:\n${paths}\nRead the relevant image files with the read tool before completing the task.`;
}

function parseLine(line: string): SessionEntry | null {
  try {
    return JSON.parse(line) as SessionEntry;
  } catch {
    return null;
  }
}

function isUserMessage(entry: SessionEntry | null): boolean {
  return entry?.type === "message" &&
    (entry as Partial<MessageEntry>).message?.role === "user";
}

/**
 * Copy the triggering turn's proven parent-id ancestry, optionally bounded
 * to its latest N user turns.
 * Entries on abandoned branches, or entries whose ancestry is missing, are
 * deliberately not guessed into a bounded fork.
 */
function getAncestryForkContentLines(
  lines: string[],
  trigger: SessionEntry,
  forkTurns: "all" | number,
): string[] {
  if (typeof trigger.parentId !== "string") return [];
  const byId = new Map<string, { line: string; entry: SessionEntry }>();
  for (const line of lines) {
    const entry = parseLine(line);
    if (entry?.type !== "session" && typeof entry?.id === "string") {
      byId.set(entry.id, { line, entry });
    }
  }

  const reverseChain: Array<{ line: string; entry: SessionEntry }> = [];
  const visited = new Set<string>();
  let parentId: string | undefined = trigger.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const found = byId.get(parentId);
    if (!found) break;
    reverseChain.push(found);
    parentId = typeof found.entry.parentId === "string" ? found.entry.parentId : undefined;
  }

  const chain = reverseChain.reverse();
  if (forkTurns === "all") return chain.map((item) => item.line);

  const userIndexes = chain
    .map((item, index) => isUserMessage(item.entry) ? index : -1)
    .filter((index) => index >= 0);
  if (userIndexes.length === 0) return [];
  const start = userIndexes[Math.max(0, userIndexes.length - forkTurns)];
  return chain.slice(start).map((item, index) => {
    if (index !== 0 || item.entry.parentId == null) return item.line;
    const rebased = { ...item.entry, parentId: null };
    return JSON.stringify(rebased);
  });
}

function getForkContentLines(parentSessionFile: string, forkTurns: "all" | number): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = parseLine(lines[i]);
      if (isUserMessage(entry)) {
        truncateAt = i;
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  const trigger = parseLine(lines[truncateAt] ?? "");
  return trigger
    ? getAncestryForkContentLines(lines.slice(0, truncateAt), trigger, forkTurns)
    : [];
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  /** Defaults to all for backward-compatible full fork mode. */
  forkTurns?: "all" | number;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork"
      ? getForkContentLines(params.parentSessionFile, params.forkTurns ?? "all")
      : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string,
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number,
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}

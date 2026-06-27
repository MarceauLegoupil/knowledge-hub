import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataPath = path.resolve(rootDir, "data.json");

const raw = await fs.readFile(dataPath, "utf8");
const data = JSON.parse(raw);
const items = Array.isArray(data) ? data.flatMap((group) => group.items || []) : data.items || [];
const forbiddenKeys = [];

walk(data, []);

for (const [index, item] of items.entries()) {
  assert(item.category, `Item ${index + 1}: category manquante`);
  assert(item.title, `Item ${index + 1}: title manquant`);
  assert(item.summary, `Item ${index + 1}: summary manquant`);
  assert(item.source_video, `Item ${index + 1}: source_video manquant`);
  assert(item.video_url, `Item ${index + 1}: video_url manquant`);
}

if (forbiddenKeys.length) {
  throw new Error(`data.json contient des champs interdits: ${forbiddenKeys.join(", ")}`);
}

console.log(`data.json valide: ${items.length} idee(s), aucune transcription brute stockee.`);

function walk(value, pathParts) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (/transcript|transcription/i.test(key) && !/status|language/i.test(key)) {
      forbiddenKeys.push(nextPath.join("."));
    }
    walk(child, nextPath);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

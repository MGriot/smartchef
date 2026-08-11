// ════════════════════════════════════════════════════════════════════════
// SmartChef — Stable Device Identity
// Folder sync writes one snapshot file per device and needs that device's
// identity to stay the same across container restarts — mdns.service.ts's
// DEVICE_ID falls back to a fresh random string every restart when the env
// var isn't set, which would corrupt snapshot-file identity here (a device
// could mistake its own older snapshot for a peer's). This persists a
// generated id to a small file on first boot instead.
// ════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";

const DEVICE_DATA_DIR = process.env.DEVICE_DATA_DIR ?? "/app/device";
const DEVICE_ID_FILE = path.join(DEVICE_DATA_DIR, "device-id.txt");

function loadOrCreateDeviceId(): string {
  if (process.env.DEVICE_ID) return process.env.DEVICE_ID;

  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const id = fs.readFileSync(DEVICE_ID_FILE, "utf-8").trim();
      if (id) return id;
    }
  } catch {
    // fall through to generate a fresh one
  }

  const id = `device-${uuidv4()}`;
  try {
    fs.mkdirSync(DEVICE_DATA_DIR, { recursive: true });
    fs.writeFileSync(DEVICE_ID_FILE, id, "utf-8");
  } catch (err) {
    console.warn(
      "⚠️ Could not persist device id — it will regenerate on the next restart:",
      (err as Error).message
    );
  }
  return id;
}

export const DEVICE_ID = loadOrCreateDeviceId();
export const DEVICE_NAME = process.env.DEVICE_NAME ?? "SmartChef Device";

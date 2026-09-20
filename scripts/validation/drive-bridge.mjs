// Drives the live Compositor MCP bridge (real Swift router + EditorSession)
// over the JSONL loopback protocol. Used by scripts/validate-native.sh after
// the headless harness starts listening.
import { readFileSync } from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The expected implemented count comes from the built registry — the same
// source of truth check-capability-parity.mjs uses — so adding a capability
// never leaves this assertion stale. Run `npm run build:protocol` first.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { CAPABILITIES } = await import(pathToFileURL(path.join(root, "packages/protocol/dist/index.js")).href);
const EXPECTED_IMPLEMENTED = CAPABILITIES.filter((entry) => entry.status === "implemented").length;

const discovery = JSON.parse(readFileSync(process.env.HOME + "/Library/Application Support/Compositor/MCP/bridge.json", "utf8"));
const results = [];
let failures = 0;

function request(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: discovery.host, port: discovery.port });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 25000);
    socket.on("connect", () => socket.write(JSON.stringify({ protocol: "compositor-bridge/1", id: randomUUID(), token: discovery.token, method, ...(params ? { params } : {}) }) + "\n"));
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(buf.subarray(0, nl).toString())); }
    });
    socket.on("error", reject);
  });
}
const exec = (operations, extra = {}) => request("execute", { operations, ...extra });
const op = (name, args) => ({ name, arguments: args });
function J(x, n = 140) { try { return (JSON.stringify(x) ?? "undefined").slice(0, n); } catch { return "?"; } }
function check(label, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}
const valueOf = (r) => r.result?.results?.[0]?.value;

const ping = await request("ping");
check("ping", ping.ok === true, J(ping.result, 80));

const caps = await request("capabilities");
check(
  `capabilities implemented=${EXPECTED_IMPLEMENTED}`,
  caps.ok && caps.result?.implemented?.length === EXPECTED_IMPLEMENTED,
  `implemented=${caps.result?.implemented?.length}`,
);

// wrong-token auth check
const badResp = await new Promise((resolve) => {
  const s = net.createConnection({ host: discovery.host, port: discovery.port });
  let buf = Buffer.alloc(0);
  s.on("connect", () => s.write(JSON.stringify({ protocol: "compositor-bridge/1", id: "x", token: "wrong-token-padding-wrong-token-padding", method: "ping" }) + "\n"));
  s.on("data", (d) => { buf = Buffer.concat([buf, d]); const nl = buf.indexOf(0x0a); if (nl >= 0) { s.destroy(); resolve(JSON.parse(buf.subarray(0, nl).toString())); } });
});
check("wrong token rejected", badResp.ok === false && badResp.error?.code === "unauthorised", badResp.error?.code);

// document lifecycle
let r = await exec([op("document.create", { width: 400, height: 300, resolution: 72 })]);
check("document.create", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0], 100));

r = await exec([op("layer.addBlank", {})]);
check("layer.addBlank", r.ok && r.result?.results?.[0]?.ok === true);

r = await exec([op("selection.rectangle", { x: 50, y: 50, width: 100, height: 80 })]);
check("selection.rectangle", r.ok && r.result?.results?.[0]?.ok === true, J(valueOf(r)));

r = await exec([op("pixels.fill", { target: "foreground" })]);
check("pixels.fill in rect selection", r.ok && r.result?.results?.[0]?.ok === true, J(r.error ?? r.result?.results?.[0]?.error));

r = await exec([op("selection.ellipse", { x: 10, y: 10, width: 40, height: 40, mode: "add" })]);
check("selection.ellipse add", r.ok && r.result?.results?.[0]?.ok === true);

r = await exec([op("selection.polygon", { points: [{ x: 200, y: 200 }, { x: 280, y: 200 }, { x: 240, y: 260 }] })]);
check("selection.polygon", r.ok && r.result?.results?.[0]?.ok === true);

r = await exec([op("selection.magicWand", { x: 100, y: 100, tolerance: 24 })]);
check("selection.magicWand", r.ok && r.result?.results?.[0]?.ok === true, J(valueOf(r) ?? r.result?.results?.[0]?.error));

r = await exec([op("selection.none", {})]);
check("selection.none (deselect)", r.ok && r.result?.results?.[0]?.ok === true);

// paint ops
r = await exec([op("paint.brushStroke", { points: [{ x: 20, y: 20 }, { x: 120, y: 120 }, { x: 200, y: 80 }], diameter: 24, color: "#0033ff" })]);
check("paint.brushStroke", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

r = await exec([op("paint.spotHeal", { points: [{ x: 100, y: 100 }, { x: 130, y: 110 }], diameter: 20, mode: "Content-Aware" })]);
check("paint.spotHeal", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

r = await exec([op("paint.clone", { source: { x: 30, y: 30 }, points: [{ x: 200, y: 200 }, { x: 250, y: 220 }], diameter: 18, aligned: false })]);
check("paint.clone", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

r = await exec([op("paint.blur", { mode: "Blur", points: [{ x: 60, y: 60 }, { x: 90, y: 90 }], diameter: 30, strength: 0.5 })]);
check("paint.blur", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

r = await exec([op("paint.gradient", { start: { x: 0, y: 0 }, end: { x: 400, y: 300 } })]);
check("paint.gradient", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

r = await exec([op("paint.shape", { kind: "Rectangle", x: 300, y: 200, width: 60, height: 50, color: "#00ff88" })]);
check("paint.shape", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

// adjustments + filters
r = await exec([op("adjustment.add", { kind: "Hue/Saturation" })]);
const adjId = valueOf(r)?.id;
check("adjustment.add Hue/Saturation", r.ok && typeof adjId === "string");
if (adjId) {
  r = await exec([op("adjustment.update", { layerId: adjId, kind: "Hue/Saturation", parameters: { saturation: 40 } })]);
  check("adjustment.update", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));
} else check("adjustment.update", false, "no adjustment layer id returned");

r = await exec([op("layer.addBlank", {})]);
check("layer.addBlank for filter", r.ok && r.result?.results?.[0]?.ok === true);
r = await exec([op("pixels.fill", { target: "foreground" })]);
r = await exec([op("filter.apply", { kind: "Gaussian Blur", settings: { radius: 4 } })]);
check("filter.apply Gaussian Blur", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

// CAF needs a selection on a pixel layer
r = await exec([op("selection.rectangle", { x: 10, y: 10, width: 30, height: 30 })]);
r = await exec([op("pixels.contentAwareFill", {})]);
check("pixels.contentAwareFill", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));
r = await exec([op("selection.none", {})]);

// geometry ops — crop is destructive: confirm gate first, then the real crop
r = await exec([op("document.crop", { x: 0, y: 0, width: 300, height: 200 })]);
check("document.crop requires confirm", r.ok === false && (r.error?.code === "confirmation_required" || JSON.stringify(r).includes("confirmation")), J(r.error ?? r.result));
r = await exec([op("document.crop", { x: 0, y: 0, width: 300, height: 200 })], { confirmDestructive: true });
check("document.crop", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

r = await exec([op("document.resizeCanvas", { width: 500, height: 400, anchor: "top-left" })]);
check("document.resizeCanvas", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

r = await exec([op("document.resizeImage", { width: 250, height: 200 })]);
check("document.resizeImage", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

// group + ungroup: layer.group groups the CURRENT selection
r = await exec([op("layer.addBlank", {})]);
const lid1 = valueOf(r)?.id;
r = await exec([op("layer.addBlank", {})]);
const lid2 = valueOf(r)?.id;
if (lid1 && lid2) {
  r = await exec([op("layer.select", { layerIds: [lid1, lid2] })]);
  r = await exec([op("layer.group", { name: "Validation Group" })]);
  const gid = valueOf(r)?.id;
  check("layer.group", r.ok && typeof gid === "string", J(r.result?.results?.[0]?.error));
  if (gid) {
    r = await exec([op("layer.ungroup", { layerId: gid })]);
    check("layer.ungroup", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));
  } else check("layer.ungroup", false, "no group id");
} else check("group/ungroup setup", false, "no layer ids");

// distort needs a layer with pixel content
r = await exec([op("layer.addBlank", {})]);
const distId = valueOf(r)?.id;
r = await exec([op("pixels.fill", { target: "foreground" })]);
if (distId) {
  r = await exec([op("layer.distort", { layerId: distId, corners: [{ x: 0, y: 0 }, { x: 200, y: 15 }, { x: 190, y: 180 }, { x: 10, y: 195 }] })]);
  check("layer.distort", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));
  r = await exec([op("layer.addMask", { layerId: distId })]);
  if (r.ok && r.result?.results?.[0]?.ok) {
    r = await exec([op("layer.featherMask", { layerId: distId, radius: 6 })]);
    check("layer.featherMask", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));
  } else check("layer.addMask (for feather)", false, J(r.result?.results?.[0]?.error));
} else check("distort setup", false, "no layer id");

// preview render -> real PNG path
r = await exec([op("preview.render", {})]);
check("preview.render", r.ok && r.result?.results?.[0]?.ok === true, J(valueOf(r)));

// atomic batch rollback: good op then a bad layerId
r = await exec([op("pixels.fill", { target: "foreground" }), op("layer.setOpacity", { layerId: "00000000-0000-0000-0000-000000000000", opacity: 0.5 })], { atomic: true });
check("atomic batch rollback on failure", r.ok === false || r.result?.rolledBack === true, J(r.result ?? r.error));

// destructive confirmation required
const stD = await request("state");
const delTarget = (stD.result?.document?.layers ?? []).find(l => l.adjustment);
if (delTarget) {
  r = await exec([op("layer.delete", { layerId: delTarget.id })]);
  check("destructive requires confirm", r.ok === false && (r.error?.code === "confirmation_required" || JSON.stringify(r).includes("confirmation")), J(r.error ?? r.result));
  r = await exec([op("layer.delete", { layerId: delTarget.id })], { confirmDestructive: true });
  check("layer.delete with confirm", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error ?? r.error));
}

// undo/redo
r = await exec([op("history.undo", {})]);
check("history.undo", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));
r = await exec([op("history.redo", {})]);
check("history.redo", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error));

const st3 = await request("state");
check("final state has document", st3.ok && st3.result?.document != null);

console.log(results.join("\n"));
console.log(`\n${results.length - failures}/${results.length} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

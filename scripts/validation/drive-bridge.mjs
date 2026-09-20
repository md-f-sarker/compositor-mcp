import { readFileSync } from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";

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
const exec = (operations, extra={}) => request("execute", { operations, ...extra });
const op = (name, arguments_) => ({ name, arguments: arguments_ });
function check(label, cond, detail="") {
  detail = detail ?? "";
  results.push(`${cond ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}
function J(x, n=140) { try { return (JSON.stringify(x) ?? "undefined").slice(0, n); } catch { return "?"; } }

const ping = await request("ping");
check("ping", ping.ok === true, J(ping.result, 80));

const caps = await request("capabilities");
check("capabilities implemented=62", caps.ok && caps.result?.implemented?.length === 62, `implemented=${caps.result?.implemented?.length}`);

// bad token auth check
const badResp = await new Promise((resolve) => {
  const s = net.createConnection({ host: discovery.host, port: discovery.port });
  let buf = Buffer.alloc(0);
  s.on("connect", () => s.write(JSON.stringify({ protocol: "compositor-bridge/1", id: "x", token: "wrong-token-padding-wrong-token-padding", method: "ping" }) + "\n"));
  s.on("data", (d) => { buf = Buffer.concat([buf, d]); const nl = buf.indexOf(0x0a); if (nl >= 0) { s.destroy(); resolve(JSON.parse(buf.subarray(0,nl).toString())); }});
});
check("wrong token rejected", badResp.ok === false && badResp.error?.code === "unauthorised", badResp.error?.code);

// document lifecycle
let r = await exec([op("document.create", { width: 400, height: 300, resolution: 72 })]);
check("document.create", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0], 100));

r = await exec([op("layer.addBlank", {})]);
check("layer.addBlank", r.ok && r.result?.results?.[0]?.ok === true);

r = await exec([op("selection.rectangle", { x: 50, y: 50, width: 100, height: 80 })]);
check("selection.rectangle", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0], 140));

r = await exec([op("pixels.fill", { color: "#ff0000" })]);
check("pixels.fill in rect selection", r.ok && r.result?.results?.[0]?.ok === true);

r = await exec([op("selection.ellipse", { x: 10, y: 10, width: 40, height: 40, mode: "add" })]);
check("selection.ellipse add", r.ok && r.result?.results?.[0]?.ok === true);

r = await exec([op("selection.polygon", { points: [{x:200,y:200},{x:280,y:200},{x:240,y:260}] })]);
check("selection.polygon", r.ok && r.result?.results?.[0]?.ok === true);

r = await exec([op("selection.magicWand", { x: 100, y: 100, tolerance: 24 })]);
check("selection.magicWand", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 140));

r = await exec([op("selection.deselect", {})]);
check("selection.deselect", r.ok && r.result?.results?.[0]?.ok === true);

// paint ops
r = await exec([op("paint.brushStroke", { points: [{x:20,y:20},{x:120,y:120},{x:200,y:80}], diameter: 24, color: "#0033ff" })]);
check("paint.brushStroke", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 140));

r = await exec([op("paint.spotHeal", { points: [{x:100,y:100},{x:130,y:110}], diameter: 20, mode: "Content-Aware" })]);
check("paint.spotHeal", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 140));

r = await exec([op("paint.clone", { source: {x:30,y:30}, points: [{x:200,y:200},{x:250,y:220}], diameter: 18, aligned: false })]);
check("paint.clone", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 140));

r = await exec([op("paint.blur", { mode: "Blur", points: [{x:60,y:60},{x:90,y:90}], diameter: 30, strength: 0.5 })]);
check("paint.blur", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 140));

r = await exec([op("paint.gradient", { start: {x:0,y:0}, end: {x:400,y:300} })]);
check("paint.gradient", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 140));

r = await exec([op("paint.shape", { kind: "Rectangle", x: 300, y: 200, width: 60, height: 50, color: "#00ff88" })]);
check("paint.shape", r.ok && r.result?.results?.[0]?.ok === true);

// adjustments + filters
r = await exec([op("adjustment.add", { kind: "Hue/Saturation" })]);
check("adjustment.add Hue/Saturation", r.ok && r.result?.results?.[0]?.ok === true);
const adjLayerId = r.result?.results?.[0]?.outcome?.layerId ?? r.result?.results?.[0]?.outcome?.id;

if (adjLayerId) {
  r = await exec([op("adjustment.update", { layerId: adjLayerId, kind: "Hue/Saturation", parameters: { saturation: 40 } })]);
  check("adjustment.update", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error ?? "", 120));
} else check("adjustment.update", false, "no adjustment layer id returned");

r = await exec([op("layer.addBlank", {})]);
check("layer.addBlank for filter", r.ok && r.result?.results?.[0]?.ok === true);
r = await exec([op("pixels.fill", { color: "#808080" })]);
r = await exec([op("filter.apply", { kind: "Gaussian Blur", settings: { radius: 4 } })]);
check("filter.apply Gaussian Blur", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 140));

// CAF needs selection
r = await exec([op("selection.rectangle", { x: 10, y: 10, width: 30, height: 30 })]);
r = await exec([op("pixels.contentAwareFill", {})]);
check("pixels.contentAwareFill", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 140));
r = await exec([op("selection.deselect", {})]);

// geometry ops
r = await exec([op("document.crop", { x: 0, y: 0, width: 300, height: 200 })]);
check("document.crop", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 120));

r = await exec([op("document.resizeCanvas", { width: 500, height: 400, anchor: "top-left" })]);
check("document.resizeCanvas", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 120));

r = await exec([op("document.resizeImage", { width: 250, height: 200 })]);
check("document.resizeImage", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 120));

// layer structure: group + ungroup
r = await exec([op("layer.addBlank", {})]);
r = await exec([op("layer.addBlank", {})]);
const state = await request("state");
const layerIds = (state.result?.document?.layers ?? state.result?.layers ?? []).filter(l=>!l.isGroup).map(l=>l.id);
if (layerIds.length >= 2) {
  r = await exec([op("layer.group", { layerIds: [layerIds[0], layerIds[1]] })]);
  check("layer.group", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error ?? "", 120));
  const gid = r.result?.results?.[0]?.outcome?.layerId ?? r.result?.results?.[0]?.outcome?.groupId ?? r.result?.results?.[0]?.outcome?.id;
  if (gid) {
    r = await exec([op("layer.ungroup", { layerId: gid })]);
    check("layer.ungroup", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error ?? r.result?.results?.[0]?.outcome ?? "", 120));
  } else check("layer.ungroup", false, "no group id");
} else check("group/ungroup", false, "not enough layers");

// distort on a layer
const st2 = await request("state");
const someLayer = (st2.result?.document?.layers ?? st2.result?.layers ?? []).find(l=>!l.isGroup);
if (someLayer) {
  r = await exec([op("layer.distort", { layerId: someLayer.id, corners: [{x:0,y:0},{x:210,y:10},{x:200,y:190},{x:10,y:200}] })]);
  check("layer.distort", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error ?? "", 120));
  // featherMask needs a mask first
  r = await exec([op("layer.addMask", { layerId: someLayer.id })]);
  if (r.ok && r.result?.results?.[0]?.ok) {
    r = await exec([op("layer.featherMask", { layerId: someLayer.id, radius: 6 })]);
    check("layer.featherMask", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error ?? "", 120));
  } else check("layer.addMask (for feather)", false, J(r, 120));
}

// preview render -> real PNG path
r = await exec([op("preview.render", {})]);
check("preview.render", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.outcome ?? r.result?.results?.[0]?.error, 160));

// atomic batch + rollback: fill then a bad op
r = await exec([op("pixels.fill", { color: "#123456" }), op("layer.setOpacity", { layerId: "00000000-0000-0000-0000-000000000000", opacity: 0.5 })], { atomic: true });
check("atomic batch rollback on failure", r.ok === false || (r.result?.rolledBack === true), J(r.result ?? r.error, 140));

// destructive confirmation required
r = await exec([op("layer.delete", { layerId: someLayer?.id ?? "x" })]);
check("destructive requires confirm", r.ok === false && (r.error?.code === "confirmation_required" || J(r).includes("confirmation")), JSON.stringify(r.error ?? r.result, 120));

// undo/redo
r = await exec([op("history.undo", {})]);
check("history.undo", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error ?? "", 100));
r = await exec([op("history.redo", {})]);
check("history.redo", r.ok && r.result?.results?.[0]?.ok === true, J(r.result?.results?.[0]?.error ?? "", 100));

const st3 = await request("state");
check("final state has document", st3.ok && (st3.result?.document != null || st3.result?.editor != null), `undoCount=${st3.result?.document?.undoCount ?? "?"}`);

console.log(results.join("\n"));
console.log(`\n${results.length - failures}/${results.length} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

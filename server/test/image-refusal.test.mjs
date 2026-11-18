// make_image / edit_image: a provider's black placeholder is a refusal, sizes are mapped,
// and Venice web's "not explicitly free" points at the paid route.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { legacy } from "../src/legacy.js";

const BLACK = fs.readFileSync(new URL("./fixtures/seedream-refusal-black.png", import.meta.url));   // what Seedream sent for a refused prompt
const PHOTO = fs.readFileSync(new URL("./fixtures/small-photo.png", import.meta.url));
const seen = [];
let base, server;
before(async () => {
  server = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const j = JSON.parse(b || "{}"); seen.push({ url: req.url, body: j });
      if (/web\/seedream/.test(j.model)) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":{"message":"Image edit model is not explicitly free and available"}}'); }
      const img = /refuse/.test(j.prompt) ? BLACK : PHOTO;
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ b64_json: img.toString("base64") }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port + "/v1";
});
after(() => server.close());

test("a black placeholder is reported as a refusal, not an image", async () => {
  const { made, failed } = await legacy.imageMake(base, "k", "please refuse", null, { model: "heretic-venice-api/seedream-v5-5" });
  assert.equal(made, null);
  assert.match(failed[0], /REFUSED by heretic-venice-api\/seedream-v5-5[\s\S]*do not retry/);
  const text = legacy.imageFailText(failed, "heretic-venice-api/seedream-v5-5");
  assert.match(text, /^The model refused the prompt/);
});

test("a real picture passes, and 16:9 becomes 1792x1024", async () => {
  const { made } = await legacy.imageMake(base, "k", "an apple", null, { model: "heretic-venice-api/z-image-turbo", size: "16:9" });
  assert.ok(made && made.bytes.length === PHOTO.length);
  assert.equal(seen.at(-1).body.size, "1792x1024");
  await legacy.imageMake(base, "k", "an apple", null, { model: "heretic-venice-api/z-image-turbo", size: "1920x1080" });
  assert.equal(seen.at(-1).body.size, "1792x1024");
  await legacy.imageMake(base, "k", "an apple", null, { model: "heretic-venice-api/z-image-turbo", size: "9:16" });
  assert.equal(seen.at(-1).body.size, "1024x1792");
  await legacy.imageMake(base, "k", "an apple", null, { model: "heretic-venice-api/z-image-turbo" });
  assert.equal(seen.at(-1).body.size, undefined);
});

test("Venice web's paid-model refusal names the paid route", async () => {
  const { failed } = await legacy.imageMake(base, "k", "an apple", null, { model: "heretic-venice-web/seedream-v5-5" });
  assert.match(legacy.imageFailText(failed, "heretic-venice-web/seedream-v5-5"), /heretic-venice-api\/<model>[\s\S]*venice-api-image-edits\/<model>-edit/);
});

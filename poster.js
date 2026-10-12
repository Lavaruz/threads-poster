#!/usr/bin/env node
"use strict";

/**
 * Threads poster: publishes text posts to Threads through Meta's official API.
 * No dependencies. Needs Node 20.12+ (built-in fetch and process.loadEnvFile).
 *
 * Commands:
 *   node poster.js exchange [--show]   swap a 1-hour token for a 60-day token
 *   node poster.js refresh [--show]    extend a 60-day token for another 60 days
 *   node poster.js whoami              check the token, save your user id
 *   node poster.js limit               show how much of the 24h publishing quota is used
 *   node poster.js post "text" [--topic TAG] [--link URL] [--dry-run]
 *   node poster.js run [--dry-run]     publish everything due in queue.json
 */

const fs = require("fs");
const path = require("path");

const ENV_FILE = path.join(__dirname, ".env");
try {
  process.loadEnvFile(ENV_FILE);
} catch {
  // No .env file: fall back to real environment variables (e.g. CI secrets).
}

const API = "https://graph.threads.net";
const VERSION = "v1.0";
const MAX_CHARS = 500;
const MAX_ATTEMPTS = 3;
const QUEUE_FILE = path.resolve(process.env.QUEUE_FILE || path.join(__dirname, "queue.json"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Add it to .env (see README.md).`);
  return value;
}

function saveEnvValue(key, value) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  process.env[key] = value;
}

async function api(method, endpoint, params = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  }
  let url = `${API}${endpoint}`;
  const init = { method };
  if (method === "GET") url += `?${body}`;
  else init.body = body;

  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new ApiError(e.message || `HTTP ${res.status}: ${text.slice(0, 200)}`, e.code, res.status);
  }
  return json;
}

// Threads allows 500 characters; emoji count as their UTF-8 byte length.
function countChars(text) {
  let total = 0;
  for (const ch of text) {
    total += /\p{Extended_Pictographic}/u.test(ch) ? Buffer.byteLength(ch) : 1;
  }
  return total;
}

function validateText(text) {
  const problem = (msg) => Object.assign(new Error(msg), { permanent: true });
  if (!text || !text.trim()) throw problem("Post text is empty.");
  if (/\[[^\]\n]{1,40}\]/.test(text)) throw problem("Post still has an unfilled [placeholder].");
  const length = countChars(text);
  if (length > MAX_CHARS) throw problem(`Post is ${length} characters (limit ${MAX_CHARS}).`);
}

async function waitForContainer(id, token) {
  for (let i = 0; i < 20; i++) {
    let info;
    try {
      info = await api("GET", `/${VERSION}/${id}`, { fields: "status,error_message", access_token: token });
    } catch {
      await sleep(5000); // status endpoint unavailable: give Threads a few seconds and carry on
      return;
    }
    if (info.status === undefined || info.status === "FINISHED") return;
    if (info.status === "ERROR" || info.status === "EXPIRED") {
      throw new Error(`Container ${info.status}${info.error_message ? `: ${info.error_message}` : ""}`);
    }
    await sleep(3000);
  }
}

async function publishText({ text, topic, link, image }) {
  validateText(text);
  if (image && link) throw Object.assign(new Error("A post can have an image or a link card, not both."), { permanent: true });
  if (image && !/^https:\/\//i.test(image)) throw Object.assign(new Error("image must be a public https URL."), { permanent: true });
  const token = need("THREADS_ACCESS_TOKEN");
  const userId = need("THREADS_USER_ID");

  // Step 1: create a media container. Step 2: publish it.
  const container = await api("POST", `/${VERSION}/${userId}/threads`, {
    media_type: image ? "IMAGE" : "TEXT",
    image_url: image,
    text,
    topic_tag: topic,
    link_attachment: link,
    access_token: token,
  });
  await waitForContainer(container.id, token);
  const published = await api("POST", `/${VERSION}/${userId}/threads_publish`, {
    creation_id: container.id,
    access_token: token,
  });

  let permalink;
  try {
    const info = await api("GET", `/${VERSION}/${published.id}`, { fields: "permalink", access_token: token });
    permalink = info.permalink;
  } catch {
    // The post is live; the permalink is only a nicety.
  }
  return { id: published.id, permalink };
}

// ---------- queue ----------

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) throw new Error(`No queue file at ${QUEUE_FILE}`);
  const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
  if (!Array.isArray(data)) throw new Error("queue.json must be a JSON array of posts.");
  return data;
}

function saveQueue(queue) {
  const tmp = `${QUEUE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2) + "\n");
  fs.renameSync(tmp, QUEUE_FILE);
}

function isDue(item, now) {
  if ((item.status || "pending") !== "pending") return false;
  if (!item.publishAt) return true;
  const when = Date.parse(item.publishAt);
  if (Number.isNaN(when)) {
    console.warn(`Skipping, invalid publishAt "${item.publishAt}": ${String(item.text).slice(0, 40)}`);
    return false;
  }
  return when <= now;
}

async function runQueue({ dryRun = false } = {}) {
  const queue = loadQueue();
  const now = Date.now();
  const maxPerRun = Number(process.env.MAX_PER_RUN || 5);
  const gapMs = Number(process.env.GAP_SECONDS || 10) * 1000;

  const due = queue
    .filter((item) => isDue(item, now))
    .sort((a, b) => (Date.parse(a.publishAt) || 0) - (Date.parse(b.publishAt) || 0))
    .slice(0, maxPerRun);

  if (!due.length) {
    console.log("Nothing due.");
    return { posted: 0, failed: 0 };
  }

  let posted = 0;
  let failed = 0;
  for (const item of due) {
    const preview = String(item.text || "").replace(/\s+/g, " ").slice(0, 60);
    if (dryRun) {
      try {
        validateText(item.text);
        console.log(`[dry run] would post: ${preview}`);
      } catch (err) {
        console.log(`[dry run] would FAIL (${err.message}): ${preview}`);
      }
      continue;
    }
    try {
      const result = await publishText({ text: item.text, topic: item.topic, link: item.link, image: item.image });
      Object.assign(item, {
        status: "posted",
        postedAt: new Date().toISOString(),
        threadsId: result.id,
        permalink: result.permalink,
      });
      delete item.lastError;
      saveQueue(queue);
      posted++;
      console.log(`Posted: ${preview}${result.permalink ? ` -> ${result.permalink}` : ""}`);
      if (posted < due.length) await sleep(gapMs);
    } catch (err) {
      if (err.code === 190) {
        throw new Error(`Access token rejected (code 190). Run "node poster.js refresh" or create a new token. ${err.message}`);
      }
      failed++;
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = err.message;
      if (err.permanent || item.attempts >= MAX_ATTEMPTS) item.status = "failed";
      saveQueue(queue);
      console.error(`Failed (attempt ${item.attempts}): ${err.message}`);
      if (!err.permanent) break; // likely a network/API problem: stop and retry next run
    }
  }
  return { posted, failed };
}

// ---------- commands ----------

async function cmdExchange(show) {
  const res = await api("GET", "/access_token", {
    grant_type: "th_exchange_token",
    client_secret: need("THREADS_APP_SECRET"),
    access_token: need("THREADS_ACCESS_TOKEN"),
  });
  saveEnvValue("THREADS_ACCESS_TOKEN", res.access_token);
  console.log(`Long-lived token saved to .env (valid about ${Math.round(res.expires_in / 86400)} days).`);
  if (show) console.log(res.access_token);
}

async function cmdRefresh(show) {
  const res = await api("GET", "/refresh_access_token", {
    grant_type: "th_refresh_token",
    access_token: need("THREADS_ACCESS_TOKEN"),
  });
  saveEnvValue("THREADS_ACCESS_TOKEN", res.access_token);
  console.log(`Token refreshed and saved to .env (valid about ${Math.round(res.expires_in / 86400)} days).`);
  if (show) console.log(res.access_token);
}

async function cmdWhoami() {
  const me = await api("GET", `/${VERSION}/me`, { fields: "id,username", access_token: need("THREADS_ACCESS_TOKEN") });
  console.log(`Logged in as @${me.username} (user id ${me.id})`);
  if (!process.env.THREADS_USER_ID) {
    saveEnvValue("THREADS_USER_ID", me.id);
    console.log("Saved THREADS_USER_ID to .env");
  } else if (process.env.THREADS_USER_ID !== me.id) {
    console.warn(`Warning: THREADS_USER_ID in .env (${process.env.THREADS_USER_ID}) does not match this token.`);
  }
}

async function cmdLimit() {
  const res = await api("GET", `/${VERSION}/${need("THREADS_USER_ID")}/threads_publishing_limit`, {
    fields: "quota_usage,config",
    access_token: need("THREADS_ACCESS_TOKEN"),
  });
  const d = Array.isArray(res.data) ? res.data[0] : res;
  const total = d.config ? d.config.quota_total : 250;
  console.log(`Published ${d.quota_usage} of ${total} allowed posts in the last 24 hours.`);
}

// Steam's store API is public: no login or key needed.
async function cmdSteam(query) {
  if (!query) throw new Error('Usage: node poster.js steam "game name or appid"');
  let appid = /^\d+$/.test(query) ? query : null;
  if (!appid) {
    const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=ID`);
    const j = await r.json();
    if (!j.items || !j.items.length) throw new Error(`No Steam result for "${query}".`);
    appid = String(j.items[0].id);
  }
  const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&cc=ID`);
  const j = await r.json();
  const d = j[appid] && j[appid].data;
  if (!d) throw new Error(`Steam has no data for app ${appid}.`);
  console.log(`${d.name} (appid ${appid})`);
  console.log(`Store: https://store.steampowered.com/app/${appid}`);
  console.log(`Header image: ${d.header_image ? d.header_image.split("?")[0] : "-"}`);
  (d.screenshots || []).slice(0, 4).forEach((x, i) => console.log(`Screenshot ${i + 1}: ${x.path_full.split("?")[0]}`));
  if (d.short_description) console.log(`About: ${d.short_description}`);
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "--show") flags[arg.slice(2)] = true;
    else if (arg === "--topic" || arg === "--link" || arg === "--image") flags[arg.slice(2)] = argv[++i];
    else rest.push(arg);
  }
  return { flags, rest };
}

function usage() {
  console.log(`Usage:
  node poster.js exchange [--show]
  node poster.js refresh [--show]
  node poster.js whoami
  node poster.js limit
  node poster.js post "text" [--topic TAG] [--link URL | --image URL] [--dry-run]
  node poster.js steam "game name or appid"
  node poster.js run [--dry-run]`);
}

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 12)) {
    throw new Error(`Node 20.12 or newer is required (you have ${process.versions.node}).`);
  }
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseArgs(argv);
  const dryRun = Boolean(flags["dry-run"]) || process.env.DRY_RUN === "1";

  switch (cmd) {
    case "exchange":
      return cmdExchange(flags.show);
    case "refresh":
      return cmdRefresh(flags.show);
    case "whoami":
      return cmdWhoami();
    case "steam":
      return cmdSteam(rest.join(" "));
    case "limit":
      return cmdLimit();
    case "post": {
      const text = rest.join(" ");
      if (dryRun) {
        validateText(text);
        console.log(`[dry run] would post (${countChars(text)}/${MAX_CHARS}): ${text}`);
        return;
      }
      const result = await publishText({ text, topic: flags.topic, link: flags.link, image: flags.image });
      console.log(`Posted${result.permalink ? `: ${result.permalink}` : ` (id ${result.id})`}`);
      return;
    }
    case "run": {
      const { failed } = await runQueue({ dryRun });
      if (failed) process.exitCode = 1;
      return;
    }
    default:
      return usage();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { countChars, validateText, publishText, runQueue, isDue };

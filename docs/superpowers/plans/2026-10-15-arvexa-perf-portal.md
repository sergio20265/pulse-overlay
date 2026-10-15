# ARVEXA Perf Portal Backend — Implementation Plan (B: arvexa-back)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the standalone ARVEXA Perf bundle from portal.arvexa.ru and add two anonymous public endpoints — a safe server-side domain probe and shareable reports — plus the `/perf` install page and the `/perf/r/<id>` report page.

**Architecture:** An isolated module inside the Next.js 16 client portal: logic in `src/lib/perf/` (pure, Node-tested), thin route handlers in `src/app/api/perf/`, pages in `src/app/perf/` (outside the auth route groups). Probe uses Node `dns`/`net`/`tls` with SSRF guards and in-memory rate limits/cache; reports are stored in one new Prisma table. The bundle files arrive from plan A's build into `public/perf/`.

**Tech Stack:** Next.js 16.2 (App Router), Prisma 7 + PostgreSQL, zod 4, next-intl 4, Node built-in test runner via `tsx`.

**Spec:** `G:\работа\arvexa-performance-overlay\docs\superpowers\specs\2026-10-15-arvexa-perf-standalone-design.md`. Companion plan A: `…\plans\2026-10-15-arvexa-perf-standalone-overlay.md` (API contracts are defined there and repeated below).

## Global Constraints

- Repo: `G:\1212\arvexa-back`; create branch `feature/perf` before the first commit. All commands run from the repo root.
- Read `node_modules/next/dist/docs/` before using a Next API not shown in this plan (repo rule in `AGENTS.md`).
- The perf module must not touch Better Auth, sessions or portal data; no `credentials` in CORS.
- Do not import `server-only` in `src/lib/perf/*` (it throws under `tsx`, which the unit tests use).
- Code comments in English; user-facing text only in `messages/ru.json` / `messages/en.json` (namespace `perf`).
- Probe: hostnames only, port 443 only, 8000 ms per host, ≤30 hosts, every resolved address must be public, connect to the vetted IP (no second resolve), send only TLS ClientHello + one `HEAD /`.
- Limits: probe 10 / 10 min per IP and 30 / hour per origin (in memory), probe cache 5 min per host; reports 5 / 10 min per IP (DB count), body ≤ 200 KB, TTL 30 days.
- Report ids: 16 chars base62.
- Reports never store query strings, hashes, cookies or form data (strip again on the server).
- Deployment to the VPS is out of scope of this plan: deploy only after the user's explicit go-ahead.

## API contracts

`POST /api/perf/probe` body `{ origin: string, hosts: string[] }` → `200 { results: ProbeResult[] }` | `400 { error: "BAD_JSON" | "INVALID" }` | `429 { error: "RATE_LIMITED" }`.
`POST /api/perf/reports` body `Snapshot` → `201 { id, url }` | `400` | `413 { error: "TOO_LARGE" }` | `429`.
Types: see `src/lib/perf/probe.ts` (`ProbeResult`) and `src/lib/perf/schema.ts` (`SnapshotSchema`) below — identical to plan A.

## File structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (+ migration) | `PerfReport` model |
| `src/lib/perf/hosts.ts` | `normalizeHostname`, `isPublicAddress` |
| `src/lib/perf/probe.ts` | `probeHost` — DNS → TCP → TLS → HEAD with per-stage timings |
| `src/lib/perf/rate-limit.ts` | `SlidingWindowLimiter`, `TtlCache` |
| `src/lib/perf/schema.ts` | zod schemas (`ProbeRequestSchema`, `SnapshotSchema`), `stripQuery`, `sanitizeSnapshot` |
| `src/lib/perf/report-id.ts` | `newReportId`, `REPORT_ID_RE` |
| `src/lib/perf/http.ts` | `PERF_CORS`, `clientIp`, `originHost` |
| `src/lib/perf/*.test.ts` | unit tests |
| `src/lib/perf/snippet.generated.ts` | written by plan A's build (`PERF_SNIPPET`, `PERF_LOADER_VERSION`, `PERF_OVERLAY_VERSION`) |
| `src/app/api/perf/probe/route.ts` | probe endpoint |
| `src/app/api/perf/reports/route.ts` | report creation |
| `src/app/perf/page.tsx` | install page (snippet + instructions) |
| `src/app/perf/r/[id]/page.tsx`, `src/components/perf/report-view.tsx` | read-only report |
| `messages/ru.json`, `messages/en.json` | `perf` namespace |
| `next.config.ts` | cache headers for `/perf/overlay.js` and `/perf/static/*` |
| `public/perf/**` | built bundle (from plan A) |
| `package.json` | `test:unit` script |

---

### Task 1: Host validation and public-address guard

**Files:**
- Create: `src/lib/perf/hosts.ts`
- Test: `src/lib/perf/hosts.test.ts`
- Modify: `package.json` (script `test:unit`)

**Interfaces:**
- Produces: `normalizeHostname(input: string): string | null`, `isPublicAddress(address: string, extraBlocked?: string[]): boolean`.

- [ ] **Step 1: Add the test script and create the branch**

```bash
git checkout -b feature/perf
```

In `package.json` `scripts` add:

```json
"test:unit": "node --import tsx --test \"src/lib/perf/*.test.ts\""
```

- [ ] **Step 2: Write the failing test** `src/lib/perf/hosts.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress, normalizeHostname } from "./hosts";

test("normalizeHostname accepts public hostnames and punycode", () => {
  assert.equal(normalizeHostname("App.GetReview.io"), "app.getreview.io");
  assert.equal(normalizeHostname("stat1.clickfraud.ru."), "stat1.clickfraud.ru");
  assert.equal(normalizeHostname("xn--80aqc2a.xn--p1ai"), "xn--80aqc2a.xn--p1ai");
});

test("normalizeHostname rejects IPs, ports, paths and junk", () => {
  for (const bad of ["10.0.0.1", "127.0.0.1", "[::1]", "::1", "localhost", "a.ru:8443", "a.ru/x", "-a.ru", "a-.ru", "", "a..ru", "x".repeat(64) + ".ru", "a.ru@b.ru"]) {
    assert.equal(normalizeHostname(bad), null, bad);
  }
});

test("isPublicAddress blocks private, loopback, link-local, CGNAT, multicast", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test("isPublicAddress allows public addresses and honours extra blocks", () => {
  assert.equal(isPublicAddress("77.88.55.88"), true);
  assert.equal(isPublicAddress("2a02:6b8::2:242"), true);
  assert.equal(isPublicAddress("::ffff:77.88.55.88"), true);
  assert.equal(isPublicAddress("77.88.55.88", ["77.88.55.88"]), false);
  assert.equal(isPublicAddress("not-an-ip"), false);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — cannot find module `./hosts`.

- [ ] **Step 4: Implement** `src/lib/perf/hosts.ts`

```ts
import { BlockList, isIP } from "node:net";

// Special-purpose ranges a public probe must never reach (RFC 6890 & co).
const blocked = new BlockList();
const V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const V6: Array<[string, number]> = [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, "ipv6");

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export function isPublicAddress(address: string, extraBlocked: string[] = []): boolean {
  const mapped = MAPPED_V4.exec(address);
  const ip = mapped ? mapped[1] : address;
  const family = isIP(ip);
  if (family === 0) return false;
  if (extraBlocked.includes(ip)) return false;
  return !blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function normalizeHostname(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  // A TLD is never all digits — this rejects IPv4 literals.
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return host;
}
```

- [ ] **Step 5: Run tests** — `npm run test:unit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json src/lib/perf/hosts.ts src/lib/perf/hosts.test.ts
git commit -m "feat(perf): hostname validation and public-address guard"
```

---

### Task 2: Domain probe

**Files:**
- Create: `src/lib/perf/probe.ts`
- Test: `src/lib/perf/probe.test.ts`

**Interfaces:**
- Consumes: `isPublicAddress` (Task 1).
- Produces:

```ts
export type ProbeStage = "dns" | "tcp" | "tls" | "http" | "done";
export type ProbeError = "TIMEOUT" | "NXDOMAIN" | "DNS" | "REFUSED" | "RESET" | "TLS" | "HTTP" | "PRIVATE";
export interface ProbeResult { host: string; ok: boolean; stage: ProbeStage; error: ProbeError | null;
  timings: { dns: number | null; tcp: number | null; tls: number | null; ttfb: number | null };
  status: number | null; cert: { authorized: boolean; daysLeft: number | null; error: string | null } | null; cached: boolean }
export interface ProbeOptions { timeoutMs?: number; port?: number; lookup?: (host: string) => Promise<string[]>; allowPrivate?: boolean; selfIps?: string[] }
export function probeHost(host: string, opts?: ProbeOptions): Promise<ProbeResult>
```

- [ ] **Step 1: Write the failing test** `src/lib/perf/probe.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { probeHost } from "./probe";

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

test("refuses hosts that resolve to private addresses without connecting", async () => {
  let connected = false;
  const server = net.createServer(() => { connected = true; });
  const port = await listen(server);
  const r = await probeHost("evil.example", { lookup: async () => ["127.0.0.1"], port, timeoutMs: 500 });
  server.close();
  assert.equal(r.ok, false);
  assert.equal(r.stage, "dns");
  assert.equal(r.error, "PRIVATE");
  assert.equal(connected, false);
});

test("refuses when any resolved address is private (mixed answers)", async () => {
  const r = await probeHost("mixed.example", { lookup: async () => ["77.88.55.88", "10.0.0.5"], timeoutMs: 500 });
  assert.equal(r.error, "PRIVATE");
});

test("reports NXDOMAIN", async () => {
  const r = await probeHost("nope.example", {
    lookup: async () => { throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); },
  });
  assert.equal(r.stage, "dns");
  assert.equal(r.error, "NXDOMAIN");
});

test("detects a host that accepts TCP but never answers the TLS handshake", async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => { sockets.push(s); s.on("error", () => {}); });
  const port = await listen(server);
  const started = Date.now();
  const r = await probeHost("hang.example", { lookup: async () => ["127.0.0.1"], allowPrivate: true, port, timeoutMs: 600 });
  sockets.forEach((s) => s.destroy());
  server.close();
  assert.equal(r.ok, false);
  assert.equal(r.stage, "tls");
  assert.equal(r.error, "TIMEOUT");
  assert.ok(r.timings.tcp !== null);
  assert.ok(Date.now() - started < 1500, "respects the overall timeout");
});

test("reports a refused connection", async () => {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  // Windows retries a refused SYN for ~1 s before ECONNREFUSED, hence the generous timeout.
  const r = await probeHost("closed.example", { lookup: async () => ["127.0.0.1"], allowPrivate: true, port, timeoutMs: 5000 });
  assert.equal(r.stage, "tcp");
  assert.equal(r.error, "REFUSED");
});

test("reports a TLS failure when the server speaks plain text", async () => {
  const server = net.createServer((s) => { s.on("error", () => {}); s.end("HTTP/1.1 400 Bad Request\r\n\r\n"); });
  const port = await listen(server);
  const r = await probeHost("plain.example", { lookup: async () => ["127.0.0.1"], allowPrivate: true, port, timeoutMs: 1000 });
  server.close();
  assert.equal(r.stage, "tls");
  assert.equal(r.error, "TLS");
});
```

- [ ] **Step 2: Run** — `npm run test:unit` → FAIL (module `./probe` missing).

- [ ] **Step 3: Implement** `src/lib/perf/probe.ts`

```ts
import { promises as dns } from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { isPublicAddress } from "./hosts";

export type ProbeStage = "dns" | "tcp" | "tls" | "http" | "done";
export type ProbeError = "TIMEOUT" | "NXDOMAIN" | "DNS" | "REFUSED" | "RESET" | "TLS" | "HTTP" | "PRIVATE";

export interface ProbeResult {
  host: string;
  ok: boolean;
  stage: ProbeStage;
  error: ProbeError | null;
  timings: { dns: number | null; tcp: number | null; tls: number | null; ttfb: number | null };
  status: number | null;
  cert: { authorized: boolean; daysLeft: number | null; error: string | null } | null;
  cached: boolean;
}

export interface ProbeOptions {
  timeoutMs?: number;
  port?: number;
  lookup?: (host: string) => Promise<string[]>;
  /** Tests only: allow loopback targets. */
  allowPrivate?: boolean;
  /** Our own server addresses, never probed. */
  selfIps?: string[];
}

const TIMEOUT = "TIMEOUT";

async function defaultLookup(host: string): Promise<string[]> {
  const records = await dns.lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function timeoutError(): Error {
  return Object.assign(new Error("timeout"), { code: TIMEOUT });
}

function codeOf(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code ?? "";
}

function connectTcp(ip: string, port: number, ms: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: ip, port });
    const timer = setTimeout(() => { s.destroy(); reject(timeoutError()); }, ms);
    s.once("connect", () => { clearTimeout(timer); resolve(s); });
    s.once("error", (e) => { clearTimeout(timer); s.destroy(); reject(e); });
  });
}

function startTls(socket: net.Socket, servername: string, ms: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    // rejectUnauthorized=false: we report certificate problems instead of failing on them.
    const s = tls.connect({ socket, servername, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => { s.destroy(); reject(timeoutError()); }, ms);
    s.once("secureConnect", () => { clearTimeout(timer); resolve(s); });
    s.once("error", (e) => { clearTimeout(timer); s.destroy(); reject(e); });
    s.once("close", () => { clearTimeout(timer); reject(Object.assign(new Error("closed"), { code: "ECONNRESET" })); });
  });
}

function headStatus(s: tls.TLSSocket, host: string, ms: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), ms);
    let buf = "";
    s.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      } else if (buf.length > 64 || buf.includes("\n")) {
        clearTimeout(timer);
        reject(Object.assign(new Error("bad http"), { code: "BAD_HTTP" }));
      }
    });
    s.once("error", (e) => { clearTimeout(timer); reject(e); });
    s.once("end", () => { clearTimeout(timer); reject(Object.assign(new Error("closed"), { code: "ECONNRESET" })); });
    s.write(
      `HEAD / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ARVEXA-Perf-Probe/1 (+https://portal.arvexa.ru/perf)\r\n` +
        "Accept: */*\r\nConnection: close\r\n\r\n",
    );
  });
}

function certInfo(s: tls.TLSSocket): ProbeResult["cert"] {
  const cert = s.getPeerCertificate();
  const validTo = cert && cert.valid_to ? Date.parse(cert.valid_to) : NaN;
  return {
    authorized: s.authorized,
    daysLeft: Number.isFinite(validTo) ? Math.floor((validTo - Date.now()) / 86_400_000) : null,
    error: s.authorized ? null : String(s.authorizationError ?? "UNKNOWN"),
  };
}

function netError(e: unknown): ProbeError {
  const code = codeOf(e);
  if (code === TIMEOUT) return "TIMEOUT";
  if (code === "ECONNREFUSED") return "REFUSED";
  if (code === "BAD_HTTP") return "HTTP";
  return "RESET";
}

export async function probeHost(host: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const port = opts.port ?? 443;
  const lookup = opts.lookup ?? defaultLookup;
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const result: ProbeResult = {
    host, ok: false, stage: "dns", error: null,
    timings: { dns: null, tcp: null, tls: null, ttfb: null },
    status: null, cert: null, cached: false,
  };

  let t = Date.now();
  let addresses: string[];
  try {
    addresses = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => setTimeout(() => reject(timeoutError()), left())),
    ]);
  } catch (e) {
    const code = codeOf(e);
    result.error = code === TIMEOUT ? "TIMEOUT" : code === "ENOTFOUND" || code === "ENODATA" ? "NXDOMAIN" : "DNS";
    return result;
  }
  result.timings.dns = Date.now() - t;
  if (addresses.length === 0) {
    result.error = "NXDOMAIN";
    return result;
  }
  if (!opts.allowPrivate && !addresses.every((a) => isPublicAddress(a, opts.selfIps))) {
    result.error = "PRIVATE";
    return result;
  }
  // Connect to the vetted address — never resolve again (DNS rebinding).
  const ip = addresses[0];

  result.stage = "tcp";
  t = Date.now();
  let socket: net.Socket;
  try {
    socket = await connectTcp(ip, port, left());
  } catch (e) {
    result.error = netError(e);
    return result;
  }
  result.timings.tcp = Date.now() - t;

  result.stage = "tls";
  t = Date.now();
  let secure: tls.TLSSocket;
  try {
    secure = await startTls(socket, host, left());
  } catch (e) {
    socket.destroy();
    result.error = codeOf(e) === TIMEOUT ? "TIMEOUT" : "TLS";
    return result;
  }
  result.timings.tls = Date.now() - t;
  result.cert = certInfo(secure);

  result.stage = "http";
  t = Date.now();
  try {
    result.status = await headStatus(secure, host, left());
    result.timings.ttfb = Date.now() - t;
    result.stage = "done";
    result.ok = true;
  } catch (e) {
    result.error = netError(e);
  } finally {
    secure.destroy();
  }
  return result;
}
```

- [ ] **Step 4: Run** — `npm run test:unit` → PASS. If the plain-text test reports `RESET` at stage `tls`, that still means `startTls` rejected with a non-timeout error → it maps to `TLS`; check `startTls`'s `close` handler fires after `error` (both reject; first wins).

- [ ] **Step 5: Live smoke (manual, needs internet)**

```bash
node --import tsx -e "import('./src/lib/perf/probe.ts').then(async m => { for (const h of ['ya.ru','app.getreview.io']) console.log(JSON.stringify(await m.probeHost(h))) })"
```

Expected: `ya.ru` → `"ok":true,"stage":"done"`, `cert.authorized:true`; `app.getreview.io` → `"ok":false` with `stage` `tcp` or `tls` and `error` `TIMEOUT` (as found on 2026-10-15).

- [ ] **Step 6: Commit**

```bash
git add src/lib/perf/probe.ts src/lib/perf/probe.test.ts
git commit -m "feat(perf): server-side TLS probe with SSRF guard"
```

---

### Task 3: Rate limiter, cache, schemas, report ids, HTTP helpers

**Files:**
- Create: `src/lib/perf/rate-limit.ts`, `src/lib/perf/schema.ts`, `src/lib/perf/report-id.ts`, `src/lib/perf/http.ts`
- Test: `src/lib/perf/rate-limit.test.ts`, `src/lib/perf/schema.test.ts`

**Interfaces:**
- Produces:
  - `class SlidingWindowLimiter { constructor(max: number, windowMs: number, now?: () => number); take(key: string): boolean }`
  - `class TtlCache<T> { constructor(ttlMs: number, now?: () => number); get(key: string): T | undefined; set(key: string, value: T): void }`
  - `ProbeRequestSchema`, `SnapshotSchema`, `type Snapshot`, `stripQuery(url: string): string`, `sanitizeSnapshot(s: Snapshot): Snapshot`
  - `newReportId(): string`, `REPORT_ID_RE: RegExp`
  - `PERF_CORS: Record<string, string>`, `clientIp(request: Request): string | null`, `originHost(request: Request, bodyOrigin: string): string`

- [ ] **Step 1: Failing tests**

`src/lib/perf/rate-limit.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowLimiter, TtlCache } from "./rate-limit";
import { REPORT_ID_RE, newReportId } from "./report-id";

test("SlidingWindowLimiter allows max hits per window and recovers", () => {
  let now = 0;
  const lim = new SlidingWindowLimiter(2, 1000, () => now);
  assert.equal(lim.take("a"), true);
  assert.equal(lim.take("a"), true);
  assert.equal(lim.take("a"), false);
  assert.equal(lim.take("b"), true);
  now = 1001;
  assert.equal(lim.take("a"), true);
});

test("TtlCache expires entries", () => {
  let now = 0;
  const cache = new TtlCache<number>(100, () => now);
  cache.set("x", 1);
  assert.equal(cache.get("x"), 1);
  now = 101;
  assert.equal(cache.get("x"), undefined);
});

test("newReportId is 16 base62 chars and unique enough", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newReportId()));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, REPORT_ID_RE);
});
```

`src/lib/perf/schema.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProbeRequestSchema, SnapshotSchema, sanitizeSnapshot, stripQuery } from "./schema";

const snapshot = {
  v: 1, loaderVersion: 1, overlayVersion: "0.3.0",
  page: "https://minmagic.ru/oferta", ua: "Mozilla/5.0", capturedAt: "2026-10-15T10:00:00.000Z",
  vitals: { ttfb: 120, lcp: 2400, cls: 0.01, inp: null, longTasks: 3, dcl: 900, load: null },
  requests: [{
    url: "https://app.getreview.io/tags/x/sdk.js?token=secret", host: "app.getreview.io", type: "script", source: "script",
    initiator: "https://stat1.clickfraud.ru/js/c.js?k=1", chain: ["stat1.clickfraud.ru"], state: "pending",
    ageMs: 34000, durationMs: null, sizeBytes: null, blocking: false,
  }],
  hosts: [{ host: "app.getreview.io", count: 0, transfer: 0, slowestMs: 34000, pending: 1, blocking: 0 }],
  cpu: [{ host: "mc.yandex.ru", ms: 270 }],
  probe: null,
};

test("stripQuery keeps origin and path", () => {
  assert.equal(stripQuery("https://a.ru/x?y=1#z"), "https://a.ru/x");
  assert.equal(stripQuery("not a url"), "");
});

test("SnapshotSchema accepts the plan-A snapshot shape", () => {
  assert.equal(SnapshotSchema.safeParse(snapshot).success, true);
});

test("SnapshotSchema rejects oversized lists and wrong enums", () => {
  assert.equal(SnapshotSchema.safeParse({ ...snapshot, requests: Array(151).fill(snapshot.requests[0]) }).success, false);
  assert.equal(SnapshotSchema.safeParse({ ...snapshot, requests: [{ ...snapshot.requests[0], state: "weird" }] }).success, false);
  assert.equal(SnapshotSchema.safeParse({ ...snapshot, v: 2 }).success, false);
});

test("sanitizeSnapshot strips queries from page, urls and initiators", () => {
  const parsed = SnapshotSchema.parse({ ...snapshot, page: "https://minmagic.ru/oferta?utm_source=x" });
  const clean = sanitizeSnapshot(parsed);
  assert.equal(clean.page, "https://minmagic.ru/oferta");
  assert.equal(clean.requests[0].url, "https://app.getreview.io/tags/x/sdk.js");
  assert.equal(clean.requests[0].initiator, "https://stat1.clickfraud.ru/js/c.js");
});

test("ProbeRequestSchema caps hosts", () => {
  assert.equal(ProbeRequestSchema.safeParse({ origin: "https://a.ru", hosts: ["a.ru"] }).success, true);
  assert.equal(ProbeRequestSchema.safeParse({ origin: "https://a.ru", hosts: [] }).success, false);
  assert.equal(ProbeRequestSchema.safeParse({ origin: "https://a.ru", hosts: Array(31).fill("a.ru") }).success, false);
});
```

- [ ] **Step 2: Run** — `npm run test:unit` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/lib/perf/rate-limit.ts`:

```ts
// In-memory limits: the portal runs as a single Next.js process on the VPS,
// so a restart resetting counters is acceptable for anonymous endpoints.

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const from = t - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((x) => x > from);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(from);
    return true;
  }

  private sweep(from: number) {
    for (const [key, list] of this.hits) {
      if (!list.some((x) => x > from)) this.hits.delete(key);
    }
  }
}

export class TtlCache<T> {
  private entries = new Map<string, { value: T; at: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, at: this.now() });
    if (this.entries.size > 5_000) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
```

`src/lib/perf/report-id.ts`:

```ts
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const REPORT_ID_RE = /^[0-9A-Za-z]{16}$/;

export function newReportId(length = 16): string {
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      // 248 = 62 * 4: rejecting larger bytes keeps the distribution uniform.
      if (b < 248 && out.length < length) out += ALPHABET[b % 62];
    }
  }
  return out;
}
```

`src/lib/perf/schema.ts`:

```ts
import { z } from "zod";

// Mirrors arvexa-performance-overlay/standalone/src/third-party-core.js buildSnapshot()
// and the portal probe result. Kept strict: this is anonymous public input.

export const ProbeRequestSchema = z.object({
  origin: z.string().max(300),
  hosts: z.array(z.string().max(253)).min(1).max(30),
});

const nullableNumber = z.number().nullable();

export const ProbeResultSchema = z.object({
  host: z.string().max(253),
  ok: z.boolean(),
  stage: z.enum(["dns", "tcp", "tls", "http", "done"]),
  error: z.enum(["TIMEOUT", "NXDOMAIN", "DNS", "REFUSED", "RESET", "TLS", "HTTP", "PRIVATE"]).nullable(),
  timings: z.object({ dns: nullableNumber, tcp: nullableNumber, tls: nullableNumber, ttfb: nullableNumber }),
  status: nullableNumber,
  cert: z.object({ authorized: z.boolean(), daysLeft: nullableNumber, error: z.string().max(200).nullable() }).nullable(),
  cached: z.boolean(),
});

const RequestViewSchema = z.object({
  url: z.string().max(2000),
  host: z.string().max(253),
  type: z.enum(["script", "iframe", "img", "link"]),
  source: z.enum(["html", "script"]),
  initiator: z.string().max(2000),
  chain: z.array(z.string().max(253)).max(10),
  state: z.enum(["pending", "loading", "done", "error"]),
  ageMs: z.number().min(0),
  durationMs: nullableNumber,
  sizeBytes: nullableNumber,
  blocking: z.boolean(),
});

export const SnapshotSchema = z.object({
  v: z.literal(1),
  loaderVersion: z.number().int().min(0).max(99),
  overlayVersion: z.string().max(20),
  page: z.string().max(2000).refine((u) => /^https?:\/\//.test(u), "http(s) url"),
  ua: z.string().max(400),
  capturedAt: z.string().max(40),
  vitals: z.object({
    ttfb: nullableNumber, lcp: nullableNumber, cls: z.number().min(0), inp: nullableNumber,
    longTasks: z.number().int().min(0), dcl: nullableNumber, load: nullableNumber,
  }),
  requests: z.array(RequestViewSchema).max(150),
  hosts: z.array(z.object({
    host: z.string().max(253), count: z.number().int().min(0), transfer: z.number().min(0),
    slowestMs: z.number().min(0), pending: z.number().int().min(0), blocking: z.number().int().min(0),
  })).max(60),
  cpu: z.array(z.object({ host: z.string().max(253), ms: z.number().min(0) })).max(30),
  probe: z.array(ProbeResultSchema).max(30).nullable(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "";
  }
}

function stripLoose(url: string): string {
  return stripQuery(url) || url.split(/[?#]/)[0];
}

// The overlay strips queries already; do it again so a modified client cannot store tokens.
export function sanitizeSnapshot(s: Snapshot): Snapshot {
  return {
    ...s,
    page: stripQuery(s.page),
    requests: s.requests.map((r) => ({
      ...r,
      url: stripLoose(r.url),
      initiator: r.initiator === "html" || r.initiator === "inline" ? r.initiator : stripLoose(r.initiator),
    })),
  };
}
```

`src/lib/perf/http.ts`:

```ts
import { normalizeHostname } from "./hosts";

// Perf endpoints are called from arbitrary client sites. No credentials are
// accepted, so a wildcard origin cannot expose portal sessions.
export const PERF_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function clientIp(request: Request): string | null {
  // Set by our own nginx vhost (proxy_set_header X-Forwarded-For ...).
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || null;
}

// The browser-set Origin header wins over the body (page JS cannot forge it).
export function originHost(request: Request, bodyOrigin: string): string {
  const raw = request.headers.get("origin") || bodyOrigin;
  try {
    return normalizeHostname(new URL(raw).hostname) ?? "unknown";
  } catch {
    return "unknown";
  }
}
```

- [ ] **Step 4: Run** — `npm run test:unit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/perf/rate-limit.ts src/lib/perf/rate-limit.test.ts src/lib/perf/schema.ts src/lib/perf/schema.test.ts src/lib/perf/report-id.ts src/lib/perf/http.ts
git commit -m "feat(perf): limits, cache, snapshot schema and report ids"
```

---

### Task 4: Probe endpoint

**Files:**
- Create: `src/app/api/perf/probe/route.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `POST /api/perf/probe`, `OPTIONS /api/perf/probe`.

- [ ] **Step 1: Implement** `src/app/api/perf/probe/route.ts`

```ts
import { NextResponse } from "next/server";
import { normalizeHostname } from "@/lib/perf/hosts";
import { PERF_CORS, clientIp, originHost } from "@/lib/perf/http";
import { probeHost, type ProbeResult } from "@/lib/perf/probe";
import { SlidingWindowLimiter, TtlCache } from "@/lib/perf/rate-limit";
import { ProbeRequestSchema } from "@/lib/perf/schema";

const perIp = new SlidingWindowLimiter(10, 10 * 60 * 1000);
const perOrigin = new SlidingWindowLimiter(30, 60 * 60 * 1000);
const cache = new TtlCache<ProbeResult>(5 * 60 * 1000);
const selfIps = (process.env.PERF_SELF_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PERF_CORS });
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "BAD_JSON" }, { status: 400, headers: PERF_CORS });
  }
  const parsed = ProbeRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID" }, { status: 400, headers: PERF_CORS });
  }
  const hosts = [...new Set(parsed.data.hosts.map(normalizeHostname).filter((h): h is string => h !== null))];
  if (hosts.length === 0) {
    return NextResponse.json({ error: "INVALID" }, { status: 400, headers: PERF_CORS });
  }

  const ip = clientIp(request) ?? "unknown";
  if (!perIp.take(ip) || !perOrigin.take(originHost(request, parsed.data.origin))) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: PERF_CORS });
  }

  const results = await Promise.all(
    hosts.map(async (host) => {
      const hit = cache.get(host);
      if (hit) return { ...hit, cached: true };
      const fresh = await probeHost(host, { selfIps });
      cache.set(host, fresh);
      return fresh;
    }),
  );
  return NextResponse.json({ results }, { headers: PERF_CORS });
}
```

- [ ] **Step 2: Typecheck/lint**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual check against the dev server**

Run `npm run dev` (background), then:

```bash
curl -s -X POST localhost:3000/api/perf/probe -H "Content-Type: application/json" -d "{\"origin\":\"https://minmagic.ru\",\"hosts\":[\"ya.ru\",\"app.getreview.io\",\"127.0.0.1\",\"localhost\"]}"
```

Expected: `results` for `ya.ru` (ok) and `app.getreview.io` (TIMEOUT); the IP and `localhost` are dropped by `normalizeHostname`. Repeat the request 10 more times → the 11th returns `429`. `curl -s -i -X OPTIONS localhost:3000/api/perf/probe` → `204` with `Access-Control-Allow-Origin: *`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/perf/probe/route.ts
git commit -m "feat(perf): public domain probe endpoint"
```

---

### Task 5: Report storage and endpoint

**Files:**
- Modify: `prisma/schema.prisma` (append model)
- Create: migration `prisma/migrations/<timestamp>_add_perf_report/`, `src/app/api/perf/reports/route.ts`

**Interfaces:**
- Consumes: `SnapshotSchema`, `sanitizeSnapshot`, `newReportId`, `PERF_CORS`, `clientIp`.
- Produces: table `PerfReport`; `POST /api/perf/reports` → `{ id, url }` where `url = ${BETTER_AUTH_URL}/perf/r/${id}`.

- [ ] **Step 1: Prisma model** — append to `prisma/schema.prisma`:

```prisma
// ─── ARVEXA Perf (anonymous public reports) ───

model PerfReport {
  id        String   @id // 16-char base62 from src/lib/perf/report-id.ts
  origin    String
  json      String // sanitized Snapshot (src/lib/perf/schema.ts)
  ip        String?
  createdAt DateTime @default(now())
  expiresAt DateTime

  @@index([ip, createdAt])
  @@index([expiresAt])
}
```

- [ ] **Step 2: Migration**

Run: `npx prisma migrate dev --name add_perf_report`
Expected: new folder `prisma/migrations/<timestamp>_add_perf_report/` with `CREATE TABLE "PerfReport"` and two indexes; client regenerated into `src/generated/prisma`. If no local database is reachable, generate the SQL offline instead and create the folder by hand:

```bash
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script > migration.sql
```

then move `migration.sql` into `prisma/migrations/<YYYYMMDDHHMMSS>_add_perf_report/migration.sql` and run `npx prisma generate`.

- [ ] **Step 3: Implement** `src/app/api/perf/reports/route.ts`

```ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PERF_CORS, clientIp } from "@/lib/perf/http";
import { newReportId } from "@/lib/perf/report-id";
import { SnapshotSchema, sanitizeSnapshot } from "@/lib/perf/schema";

const MAX_BODY = 200 * 1024;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PERF_CORS });
}

export async function POST(request: Request) {
  const text = await request.text();
  if (text.length > MAX_BODY) {
    return NextResponse.json({ error: "TOO_LARGE" }, { status: 413, headers: PERF_CORS });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "BAD_JSON" }, { status: 400, headers: PERF_CORS });
  }
  const parsed = SnapshotSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID" }, { status: 400, headers: PERF_CORS });
  }
  const snapshot = sanitizeSnapshot(parsed.data);

  const ip = clientIp(request);
  if (ip) {
    const recent = await db.perfReport.count({
      where: { ip, createdAt: { gt: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) } },
    });
    if (recent >= RATE_LIMIT_MAX) {
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: PERF_CORS });
    }
  }

  // Expired reports are purged here instead of a cron job.
  await db.perfReport.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  const id = newReportId();
  await db.perfReport.create({
    data: {
      id,
      origin: new URL(snapshot.page).origin,
      json: JSON.stringify(snapshot),
      ip,
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });

  const base = (process.env.BETTER_AUTH_URL ?? new URL(request.url).origin).replace(/\/$/, "");
  return NextResponse.json({ id, url: `${base}/perf/r/${id}` }, { status: 201, headers: PERF_CORS });
}
```

- [ ] **Step 4: Typecheck/lint** — `npx tsc --noEmit -p tsconfig.json && npm run lint` → clean.

- [ ] **Step 5: Manual check** (dev server running)

Save the `snapshot` object from `schema.test.ts` (with `page` `https://minmagic.ru/oferta?utm_source=x`) as `C:/Temp/perf-audit/snap.json`, then:

```bash
curl -s -X POST localhost:3000/api/perf/reports -H "Content-Type: application/json" --data-binary @"C:/Temp/perf-audit/snap.json"
```

Expected: `201 {"id":"…16 chars…","url":"…/perf/r/…"}`; `npx prisma studio` shows the row with `page` without `?utm_source`. Sixth request within 10 min → `429`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/app/api/perf/reports/route.ts
git commit -m "feat(perf): anonymous shareable reports"
```

---

### Task 6: Pages — install page and report view

**Files:**
- Create: `src/app/perf/page.tsx`, `src/app/perf/r/[id]/page.tsx`, `src/components/perf/report-view.tsx`
- Modify: `messages/ru.json`, `messages/en.json` (add `perf` namespace)
- Requires: `src/lib/perf/snippet.generated.ts` (from plan A build: `node tools/build-standalone.mjs` in the overlay repo; it writes this file and `public/perf/**`)

**Interfaces:**
- Consumes: `PERF_SNIPPET`, `PERF_OVERLAY_VERSION` from `snippet.generated.ts`; `SnapshotSchema`, `REPORT_ID_RE`; existing `CopyButton` (`@/components/copy-button`), `Card*` (`@/components/ui/card`).

- [ ] **Step 1: Messages** — add to `messages/ru.json` (top-level key `perf`):

```json
"perf": {
  "title": "ARVEXA Perf — что тормозит ваш сайт",
  "lead": "Вставьте код на сайт, откройте любую страницу с ?arvexa=1 — появится панель: какие сторонние сервисы не отвечают, блокируют отрисовку и грузят процессор, и кто их подключил.",
  "snippetTitle": "Код вставки",
  "snippetHint": "Вставьте первым элементом внутри <head>. Для обычных посетителей код ничего не делает и ничего не загружает.",
  "copySnippet": "Скопировать код",
  "howTitle": "Куда вставить",
  "howTilda": "Tilda: Настройки сайта → Ещё → HTML-код для вставки внутрь head.",
  "howHtml": "Обычный HTML-сайт: в начало <head> каждого шаблона страницы.",
  "howWp": "WordPress: лучше поставить плагин Arvexa Performance Overlay из каталога WordPress.",
  "openTitle": "Как открыть панель",
  "openText": "Добавьте к адресу страницы ?arvexa=1 — панель будет показываться вам 7 дней на всех страницах. Выключить: ?arvexa=0.",
  "privacy": "Панель работает в вашем браузере. На сервер ARVEXA уходят только список доменов (кнопка «Проверить») и отчёт без параметров адресов и личных данных (кнопка «Поделиться»).",
  "version": "Версия {version}",
  "report": {
    "title": "Отчёт ARVEXA Perf",
    "page": "Страница",
    "captured": "Снят",
    "browser": "Браузер",
    "vitals": "Показатели",
    "dcl": "Страница построена",
    "load": "Полностью загружена",
    "notLoaded": "не догрузилась",
    "pending": "Не отвечают",
    "hangs": "висит {seconds} с",
    "failed": "ошибка",
    "blocking": "Блокируют отрисовку",
    "hosts": "Домены",
    "requests": "{count} запр.",
    "cpu": "Нагрузка на процессор",
    "probe": "Проверка с сервера ARVEXA",
    "probeOk": "отвечает · {ms} мс",
    "probeFail": "{stage}: {error}",
    "addedBy": "Подключил: {initiator}",
    "initiatorHtml": "HTML страницы",
    "initiatorInline": "встроенный код страницы",
    "none": "Проблем не найдено",
    "expires": "Отчёт хранится 30 дней."
  }
}
```

Add the same keys to `messages/en.json` with English text:

```json
"perf": {
  "title": "ARVEXA Perf — what slows your site down",
  "lead": "Paste the snippet into your site and open any page with ?arvexa=1 — a panel shows which third-party services hang, block rendering or load the CPU, and who added them.",
  "snippetTitle": "Snippet",
  "snippetHint": "Paste it as the first element inside <head>. For regular visitors it does nothing and loads nothing.",
  "copySnippet": "Copy snippet",
  "howTitle": "Where to paste it",
  "howTilda": "Tilda: Site settings → More → HTML code for the head section.",
  "howHtml": "Plain HTML site: at the start of <head> in every page template.",
  "howWp": "WordPress: install the Arvexa Performance Overlay plugin from the WordPress directory instead.",
  "openTitle": "How to open the panel",
  "openText": "Add ?arvexa=1 to a page address — the panel stays on for you for 7 days on every page. Turn it off with ?arvexa=0.",
  "privacy": "The panel runs in your browser. Only the list of domains (Check button) and a report without URL parameters or personal data (Share button) are sent to the ARVEXA server.",
  "version": "Version {version}",
  "report": {
    "title": "ARVEXA Perf report",
    "page": "Page",
    "captured": "Captured",
    "browser": "Browser",
    "vitals": "Metrics",
    "dcl": "DOM ready",
    "load": "Fully loaded",
    "notLoaded": "never finished",
    "pending": "Not responding",
    "hangs": "hangs {seconds} s",
    "failed": "failed",
    "blocking": "Block rendering",
    "hosts": "Domains",
    "requests": "{count} req",
    "cpu": "CPU load",
    "probe": "Check from the ARVEXA server",
    "probeOk": "answers · {ms} ms",
    "probeFail": "{stage}: {error}",
    "addedBy": "Added by: {initiator}",
    "initiatorHtml": "page HTML",
    "initiatorInline": "inline code on the page",
    "none": "No problems found",
    "expires": "The report is kept for 30 days."
  }
}
```

- [ ] **Step 2: Install page** `src/app/perf/page.tsx`

```tsx
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CopyButton } from "@/components/copy-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PERF_OVERLAY_VERSION, PERF_SNIPPET } from "@/lib/perf/snippet.generated";

export const metadata: Metadata = { title: "ARVEXA Perf" };

export default async function PerfInstallPage() {
  const t = await getTranslations("perf");
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("lead")}</p>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>{t("snippetTitle")}</CardTitle>
          <CopyButton value={PERF_SNIPPET} label={t("copySnippet")} />
        </CardHeader>
        <CardContent className="space-y-2">
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs break-all whitespace-pre-wrap">{PERF_SNIPPET}</pre>
          <p className="text-sm text-muted-foreground">{t("snippetHint")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("howTitle")}</CardTitle></CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>{t("howTilda")}</li>
            <li>{t("howHtml")}</li>
            <li>{t("howWp")}</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("openTitle")}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>{t("openText")}</p>
          <p className="text-muted-foreground">{t("privacy")}</p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">{t("version", { version: PERF_OVERLAY_VERSION })}</p>
    </main>
  );
}
```

- [ ] **Step 3: Report view** `src/components/perf/report-view.tsx`

```tsx
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Snapshot } from "@/lib/perf/schema";

function ms(v: number | null): string {
  if (v === null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

function kb(v: number): string {
  return v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : `${Math.round(v / 1024)} KB`;
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "poor" | "warn" | "good" }) {
  const color = tone === "poor" ? "text-red-600" : tone === "warn" ? "text-amber-600" : tone === "good" ? "text-green-600" : "";
  return (
    <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0">
      <span className="truncate">{label}</span>
      <span className={`shrink-0 tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

export async function ReportView({ snapshot, createdAt }: { snapshot: Snapshot; createdAt: Date }) {
  const t = await getTranslations("perf.report");
  const initiator = (i: string) => {
    if (i === "html") return t("initiatorHtml");
    if (i === "inline") return t("initiatorInline");
    try {
      return new URL(i).hostname;
    } catch {
      return i;
    }
  };
  const bad = snapshot.requests.filter((r) => r.state === "pending" || r.state === "error");
  const blocking = snapshot.requests.filter((r) => r.blocking && r.state !== "pending");

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm break-all">{t("page")}: {snapshot.page}</p>
        <p className="text-sm text-muted-foreground">
          {t("captured")}: {createdAt.toLocaleString("ru-RU")} · {t("browser")}: {snapshot.ua}
        </p>
      </header>

      <Card>
        <CardHeader><CardTitle>{t("vitals")}</CardTitle></CardHeader>
        <CardContent>
          <Row label="LCP" value={ms(snapshot.vitals.lcp)} />
          <Row label="CLS" value={snapshot.vitals.cls.toFixed(3)} />
          <Row label="INP" value={ms(snapshot.vitals.inp)} />
          <Row label={t("dcl")} value={ms(snapshot.vitals.dcl)} />
          <Row label={t("load")} value={snapshot.vitals.load === null ? t("notLoaded") : ms(snapshot.vitals.load)} tone={snapshot.vitals.load === null ? "poor" : undefined} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("pending")}</CardTitle></CardHeader>
        <CardContent>
          {bad.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : bad.map((r) => (
            <div key={r.url} className="border-b py-2 text-sm last:border-0">
              <Row label={r.host} value={r.state === "pending" ? t("hangs", { seconds: Math.round(r.ageMs / 1000) }) : t("failed")} tone="poor" />
              <p className="break-all text-xs text-muted-foreground">{r.url}</p>
              <p className="text-xs">{t("addedBy", { initiator: initiator(r.initiator) })}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {blocking.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t("blocking")}</CardTitle></CardHeader>
          <CardContent>{blocking.map((r) => <Row key={r.url} label={r.url} value={ms(r.durationMs)} tone="warn" />)}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>{t("hosts")}</CardTitle></CardHeader>
        <CardContent>
          {snapshot.hosts.slice(0, 20).map((g) => (
            <Row key={g.host} label={g.host} tone={g.pending ? "poor" : undefined}
              value={[t("requests", { count: g.count }), g.transfer ? kb(g.transfer) : null, ms(g.slowestMs)].filter(Boolean).join(" · ")} />
          ))}
        </CardContent>
      </Card>

      {snapshot.cpu.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t("cpu")}</CardTitle></CardHeader>
          <CardContent>{snapshot.cpu.map((c) => <Row key={c.host} label={c.host} value={ms(c.ms)} tone={c.ms > 600 ? "poor" : c.ms > 200 ? "warn" : undefined} />)}</CardContent>
        </Card>
      )}

      {snapshot.probe && (
        <Card>
          <CardHeader><CardTitle>{t("probe")}</CardTitle></CardHeader>
          <CardContent>
            {snapshot.probe.map((p) => (
              <Row key={p.host} label={p.host} tone={p.ok ? "good" : "poor"}
                value={p.ok
                  ? t("probeOk", { ms: Math.round((p.timings.dns ?? 0) + (p.timings.tcp ?? 0) + (p.timings.tls ?? 0) + (p.timings.ttfb ?? 0)) })
                  : t("probeFail", { stage: p.stage, error: p.error ?? "" })} />
            ))}
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">{t("expires")}</p>
    </main>
  );
}
```

- [ ] **Step 4: Report page** `src/app/perf/r/[id]/page.tsx`

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportView } from "@/components/perf/report-view";
import { db } from "@/lib/db";
import { REPORT_ID_RE } from "@/lib/perf/report-id";
import { SnapshotSchema } from "@/lib/perf/schema";

export const metadata: Metadata = {
  title: "ARVEXA Perf",
  robots: { index: false, follow: false },
};

export default async function PerfReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!REPORT_ID_RE.test(id)) notFound();
  const row = await db.perfReport.findUnique({ where: { id } });
  if (!row || row.expiresAt < new Date()) notFound();
  const parsed = SnapshotSchema.safeParse(JSON.parse(row.json));
  if (!parsed.success) notFound();
  return <ReportView snapshot={parsed.data} createdAt={row.createdAt} />;
}
```

- [ ] **Step 5: Bring in the bundle**

In `G:\работа\arvexa-performance-overlay` run `node tools/build-standalone.mjs` (defaults: production API, portal `G:/1212/arvexa-back`). Expected: `public/perf/overlay.js`, `public/perf/static/overlay.<hash>.{js,css}`, `src/lib/perf/snippet.generated.ts` appear in the portal.

- [ ] **Step 6: Typecheck, lint, build**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npm run build`
Expected: success; build output lists `/perf` and `/perf/r/[id]`.

- [ ] **Step 7: Manual check** (dev server)

Open `http://localhost:3000/perf` while logged out: page renders in Russian, «Скопировать код» copies the snippet (toast «Скопировано» or the existing `common.copied` text). Open the `url` returned in Task 5's manual check: report renders, `getreview` under «Не отвечают» with «Подключил: stat1.clickfraud.ru». Open `/perf/r/AAAAAAAAAAAAAAAA` → 404; `/perf/r/bad` → 404. View source of the report page: `<meta name="robots" content="noindex, nofollow">`.

- [ ] **Step 8: Commit**

```bash
git add messages/ru.json messages/en.json src/app/perf src/components/perf src/lib/perf/snippet.generated.ts public/perf
git commit -m "feat(perf): install page, report page and standalone bundle"
```

---

### Task 7: Static caching and end-to-end check

**Files:**
- Modify: `next.config.ts`

- [ ] **Step 1: Cache headers** — in `next.config.ts` add to `nextConfig`:

```ts
  // Standalone ARVEXA Perf bundle: hashed files are immutable, the pointer is short-lived.
  async headers() {
    return [
      {
        source: "/perf/static/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/perf/overlay.js",
        headers: [{ key: "Cache-Control", value: "public, max-age=300" }],
      },
    ];
  },
```

- [ ] **Step 2: Verify headers** — `npm run build && npm run start` (background), then:

```bash
curl -s -I localhost:3000/perf/overlay.js | grep -i cache-control
curl -s -I localhost:3000/perf/static/$(ls public/perf/static | grep '\.js$' | head -1) | grep -i cache-control
```

Expected: `public, max-age=300` and `public, max-age=31536000, immutable`.

- [ ] **Step 3: End-to-end with the harness against the local portal**

1. In the overlay repo: `node tools/build-standalone.mjs --api http://127.0.0.1:3000 --portal G:/1212/arvexa-back` — this writes `standalone/dist/snippet.html` and the portal's `public/perf` with the local portal as API.
2. Restart `npm run start` in the portal (picks up the new `public/perf`).
3. In the overlay repo run `node standalone/harness/serve.mjs` (background) — it injects `dist/snippet.html`, so the overlay now loads from and talks to the portal on :3000.
4. Open `http://localhost:4000/?arvexa=1`. In the panel: «Проверить с сервера ARVEXA» → rows for `127.0.0.3`/`127.0.0.2` are absent (IPs are filtered client-side) and the hint «Нет сторонних доменов для проверки.» appears; «Поделиться отчётом» → link `http://localhost:3000/perf/r/…` (from `BETTER_AUTH_URL`) opens the report showing `127.0.0.2` under «Не отвечают».

Then rebuild for production: `node tools/build-standalone.mjs` (overwrites `public/perf` and the snippet with the production API).

- [ ] **Step 4: Commit**

```bash
git add next.config.ts public/perf src/lib/perf/snippet.generated.ts
git commit -m "feat(perf): cache headers for the standalone bundle"
```

- [ ] **Step 5: Hand-off for deployment (do not deploy yourself)**

Report to the user: migration to apply on the VPS (`npx prisma migrate deploy`), env var `PERF_SELF_IPS=<VPS public IPv4>,<IPv6>`, and that nginx must keep passing `X-Forwarded-For`. Deploy only after explicit approval.

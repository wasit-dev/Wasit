/**
 * The service as a separate OS user (D-022a option 2; Najmi, 2026-11-16: only
 * when a payer key variable is set AND the runner is GitHub-hosted).
 *
 * What these tests can show: when the run wants a separate user, Wasit makes
 * the user with passwordless sudo, gives it access to the working directory
 * only, starts the command through `sudo -n -E -u <user>` with the scrubbed
 * environment, refuses to start when sudo or the user cannot be had (no
 * fallback to the runner's own user), and stops the service through sudo.
 * The sudo here is a stand-in script that records each call and runs the
 * command as the same user: what these tests CANNOT show is the separation
 * itself, which only a GitHub-hosted runner can (the example repository's run).
 *
 * Written before the code (CONTEXT rule 3). No key is real.
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { SERVICE_USER, ServiceError, serviceUserFor, startService, type StartedService } from "../../src/service.js";

const POSIX = process.platform !== "win32";
const CANARY = "SCANARYKEYTHATHOLDSNOTHINGATALLXXXXXXXXXXXXXXXXXXXXXXXXXX";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("serviceUserFor", () => {
  const hosted = { RUNNER_ENVIRONMENT: "github-hosted", GITHUB_ACTIONS: "true" };

  it("wants a separate user when a payer key is set on a GitHub-hosted runner", () => {
    assert.equal(serviceUserFor({ ...hosted, STELLAR_PRIVATE_KEY: "S" }), SERVICE_USER);
    assert.equal(serviceUserFor({ ...hosted, EVM_PRIVATE_KEY: "0x1" }), SERVICE_USER);
  });

  it("does not without a key, with a blank key, on a self-hosted runner, or outside GitHub", () => {
    assert.equal(serviceUserFor(hosted), undefined);
    assert.equal(serviceUserFor({ ...hosted, STELLAR_PRIVATE_KEY: "" }), undefined);
    assert.equal(serviceUserFor({ RUNNER_ENVIRONMENT: "self-hosted", GITHUB_ACTIONS: "true", STELLAR_PRIVATE_KEY: "S" }), undefined);
    assert.equal(serviceUserFor({ STELLAR_PRIVATE_KEY: "S" }), undefined);
  });

  it("is a fixed name, not one a config or a variable can choose", () => {
    assert.equal(SERVICE_USER, "wasit-service");
  });
});

describe("startService as a separate user", { skip: !POSIX && "needs POSIX; not run on Windows" }, () => {
  let dir: string;
  let work: string;
  const started: StartedService[] = [];

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-service-user-"));
    work = path.join(dir, "work");
    await writeFile(path.join(dir, ".keep"), "");
    await import("node:fs/promises").then((fs) => fs.mkdir(work));
  });
  after(async () => {
    await Promise.all(started.map((service) => service.stop()));
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A stand-in for sudo: records its arguments, one call a line, in `log`.
   * `id -u` fails (no such user yet) unless `userExists`; `useradd` and
   * `setfacl` succeed unless `failOn` names them; `-E -u <user> -- <cmd>` runs
   * the command (as the same user) after writing its pid; `pkill` and `pgrep`
   * act on that pid's process group.
   */
  async function fakeSudo(name: string, options: { failOn?: string; userExists?: boolean } = {}) {
    const log = path.join(dir, `${name}.log`);
    const pidFile = path.join(dir, `${name}.pid`);
    const script = path.join(dir, `${name}.sh`);
    await writeFile(
      script,
      `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
[ "$1" = "-n" ] || { echo "sudo stand-in: expected -n first" >&2; exit 64; }
shift
case "$1" in
  id) ${options.userExists === true ? "exit 0" : "exit 1"} ;;
  useradd|setfacl) [ "$1" = '${options.failOn ?? "-"}' ] && { echo "$1: refused by the test" >&2; exit 1; }; exit 0 ;;
  pgrep) [ -f '${pidFile}' ] && kill -0 "-$(cat '${pidFile}')" 2>/dev/null && exit 0; exit 1 ;;
  pkill) sig="$2"; [ -f '${pidFile}' ] && kill "$sig" "-$(cat '${pidFile}')" 2>/dev/null; exit 0 ;;
  -E) shift; [ "$1" = "-u" ] || exit 65; shift 2; [ "$1" = "--" ] || exit 66; shift
      echo $$ > '${pidFile}'
      exec "$@" ;;
  *) echo "sudo stand-in: unexpected $1" >&2; exit 67 ;;
esac
`,
    );
    await chmod(script, 0o755);
    return { script, log, pidFile, calls: async () => (await readFile(log, "utf-8")).trim().split("\n") };
  }

  async function serverScript(port: number): Promise<string> {
    const file = path.join(dir, `server-${port}.mjs`);
    await writeFile(
      file,
      `import http from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(path.join(dir, `env-${port}.json`))}, JSON.stringify(process.env));
http.createServer((q, s) => { s.writeHead(200); s.end("ok"); }).listen(${port}, "127.0.0.1");
`,
    );
    return file;
  }

  it("makes the user, grants it the working directory, starts the command through sudo -u, without the key", async () => {
    const sudo = await fakeSudo("ok");
    const port = await freePort();
    const script = await serverScript(port);
    const service = await startService({
      command: `node ${JSON.stringify(script)}`,
      ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 15 },
      env: { PATH: process.env["PATH"] ?? "", STELLAR_PRIVATE_KEY: CANARY, WASIT_HEADER_X_KEY: "hdr-secret", KEEP_ME: "yes" },
      cwd: work,
      separateUser: { name: SERVICE_USER, sudo: sudo.script },
      log: () => undefined,
    });
    started.push(service);

    const calls = await sudo.calls();
    assert.ok(calls.some((call) => /^-n id -u wasit-service$/.test(call)), calls.join("\n"));
    assert.ok(calls.some((call) => /^-n useradd .*--system.*wasit-service$/.test(call)), calls.join("\n"));
    assert.ok(calls.some((call) => call.startsWith("-n setfacl -R -m u:wasit-service:rwX") && call.endsWith(work.split(path.sep).pop() ?? "")), calls.join("\n"));
    const launch = calls.find((call) => call.startsWith("-n -E -u wasit-service -- env "));
    assert.ok(launch, calls.join("\n"));
    assert.match(launch, /HOME=\/home\/wasit-service/);
    assert.match(launch, /USER=wasit-service/);
    assert.ok(!launch.includes(CANARY) && !launch.includes("hdr-secret"), "a secret was put on the command line");
    assert.ok(!launch.includes("KEEP_ME"), "the environment is passed by sudo -E, not on the command line");

    const childEnv = JSON.parse(await readFile(path.join(dir, `env-${port}.json`), "utf-8"));
    assert.equal(childEnv["KEEP_ME"], "yes");
    assert.equal(childEnv["STELLAR_PRIVATE_KEY"], undefined);
    assert.equal(childEnv["WASIT_HEADER_X_KEY"], undefined);
    assert.ok(!JSON.stringify(childEnv).includes(CANARY));

    await service.stop();
    const after = await sudo.calls();
    assert.ok(after.some((call) => call === "-n pkill -TERM -u wasit-service"), after.join("\n"));
    const pid = Number((await readFile(sudo.pidFile, "utf-8")).trim());
    assert.ok(await waitUntil(() => !alive(pid), 5000), "the service is still running");
  });

  it("does not make the user again when it exists", async () => {
    const sudo = await fakeSudo("exists", { userExists: true });
    const port = await freePort();
    const service = await startService({
      command: `node ${JSON.stringify(await serverScript(port))}`,
      ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 15 },
      env: { PATH: process.env["PATH"] ?? "" },
      cwd: work,
      separateUser: { name: SERVICE_USER, sudo: sudo.script },
      log: () => undefined,
    });
    started.push(service);
    assert.ok(!(await sudo.calls()).some((call) => call.includes("useradd")));
    await service.stop();
  });

  for (const step of ["useradd", "setfacl"]) {
    it(`refuses to start when ${step} fails, and does not fall back to the runner's own user`, async () => {
      const sudo = await fakeSudo(`fail-${step}`, { failOn: step });
      const port = await freePort();
      await assert.rejects(
        startService({
          command: `node ${JSON.stringify(await serverScript(port))}`,
          ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 5 },
          env: { PATH: process.env["PATH"] ?? "", STELLAR_PRIVATE_KEY: CANARY },
          cwd: work,
          separateUser: { name: SERVICE_USER, sudo: sudo.script },
          log: () => undefined,
        }),
        (error: unknown) =>
          error instanceof ServiceError && /separate user/.test(error.message) && !error.message.includes(CANARY),
      );
      assert.ok(!(await sudo.calls()).some((call) => call.startsWith("-n -E")), "the service was started");
    });
  }

  it("refuses when sudo itself cannot be run", async () => {
    const port = await freePort();
    await assert.rejects(
      startService({
        command: "node -e 0",
        ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 5 },
        env: { PATH: process.env["PATH"] ?? "" },
        cwd: work,
        separateUser: { name: SERVICE_USER, sudo: path.join(dir, "no-such-sudo") },
        log: () => undefined,
      }),
      (error: unknown) => error instanceof ServiceError && /separate user/.test(error.message),
    );
  });
});

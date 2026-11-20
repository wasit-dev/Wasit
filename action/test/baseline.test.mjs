/**
 * Choosing the baseline (spec A5, A8 #4, A-A05): pick the RUN first, then take
 * that run's `wasit-baseline` artifact by run id. The run is the latest
 * successful `push` run of this workflow on the default branch, from this
 * repository. Never "the newest artifact with that name": a pull request run,
 * a fork's run or a run on a branch called main in a fork can upload an artifact
 * with that name, and none of them may become the baseline.
 *
 * The content of the file is not read here: the CLI validates it (core, `readBaseline`).
 * The `gh` call is injected; nothing touches the network or a token.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { ACCEPTED_CONCLUSIONS, BASELINE_ARTIFACT, findBaseline, main, selectBaselineRun } from "../scripts/baseline.mjs";

const REPOSITORY = "acme/paywall";
const CONTEXT = { repository: REPOSITORY, defaultBranch: "main", workflowId: 4242, currentRunId: 900 };

function run(overrides = {}) {
  return {
    id: 100,
    workflow_id: 4242,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_repository: { full_name: REPOSITORY },
    repository: { full_name: REPOSITORY },
    created_at: "2026-11-10T10:00:00Z",
    ...overrides,
  };
}

describe("selectBaselineRun", () => {
  it("takes the newest successful push run on the default branch of this repository", () => {
    const chosen = selectBaselineRun(
      [run({ id: 1, created_at: "2026-11-01T00:00:00Z" }), run({ id: 3, created_at: "2026-11-12T00:00:00Z" }), run({ id: 2, created_at: "2026-11-05T00:00:00Z" })],
      CONTEXT,
    );
    assert.equal(chosen?.id, 3);
  });

  it("takes a schedule or a workflow_dispatch run on the default branch as well: the payment tier runs there (D-022a)", () => {
    for (const event of ["schedule", "workflow_dispatch"]) {
      const chosen = selectBaselineRun([run({ id: 1, created_at: "2026-11-01T00:00:00Z" }), run({ id: 2, event, created_at: "2026-11-12T00:00:00Z" })], CONTEXT);
      assert.equal(chosen?.id, 2, event);
    }
  });

  it("breaks a tie in time by the higher run id", () => {
    assert.equal(selectBaselineRun([run({ id: 5 }), run({ id: 6 })], CONTEXT)?.id, 6);
  });

  it("is undefined when there is nothing to choose", () => {
    assert.equal(selectBaselineRun([], CONTEXT), undefined);
    assert.equal(selectBaselineRun(undefined, CONTEXT), undefined);
  });

  describe("a run that is not a baseline, however new it is", () => {
    const old = run({ id: 1, created_at: "2026-11-01T00:00:00Z" });
    const newer = { created_at: "2026-11-14T00:00:00Z" };
    const cases = {
      "a pull request run (even one from a branch called main)": run({ ...newer, id: 2, event: "pull_request" }),
      "a pull request run whose head repository is a fork": run({ ...newer, id: 3, event: "pull_request", head_repository: { full_name: "mallory/paywall" } }),
      "a push run whose head repository is another one": run({ ...newer, id: 4, head_repository: { full_name: "mallory/paywall" } }),
      "a run of another repository": run({ ...newer, id: 5, repository: { full_name: "mallory/paywall" } }),
      "a run on another branch": run({ ...newer, id: 8, head_branch: "feature" }),
      "a run on a branch whose name only starts with main": run({ ...newer, id: 9, head_branch: "main-evil" }),
      "a failed run": run({ ...newer, id: 10, conclusion: "failure" }),
      "a cancelled run": run({ ...newer, id: 11, conclusion: "cancelled" }),
      "a run that is not finished": run({ ...newer, id: 12, status: "in_progress", conclusion: null }),
      "a run of another workflow": run({ ...newer, id: 13, workflow_id: 7 }),
      "a merge_group run": run({ ...newer, id: 16, event: "merge_group" }),
      "a workflow_run run": run({ ...newer, id: 17, event: "workflow_run" }),
      "the run that is running now": run({ ...newer, id: 900 }),
      "a run with no head repository": run({ ...newer, id: 14, head_repository: null }),
      "a run whose id is not a whole number": run({ ...newer, id: "15; rm -rf /" }),
    };
    for (const [label, forged] of Object.entries(cases)) {
      it(`ignores ${label}`, () => {
        assert.equal(selectBaselineRun([forged, old], CONTEXT)?.id, 1);
      });
    }

    it("is undefined when only such runs are there", () => {
      assert.equal(selectBaselineRun(Object.values(cases), CONTEXT), undefined);
    });
  });

  it("accepts only the conclusions it lists, which are 'success'", () => {
    assert.deepEqual([...ACCEPTED_CONCLUSIONS], ["success"]);
  });

  it("compares repository names without case", () => {
    assert.equal(selectBaselineRun([run({ head_repository: { full_name: "Acme/Paywall" }, repository: { full_name: "ACME/paywall" } })], CONTEXT)?.id, 100);
  });
});

/** A fake gh for the whole flow, with the runs and artifacts it should answer. */
function fakeGh({ workflowId = 4242, runs = [], artifacts = {}, defaultBranch = "main", files = { "baseline.json": '{"schema":1}' }, failOn } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const text = args.join(" ");
    if (failOn !== undefined && text.includes(failOn)) return { code: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)" };
    if (args[0] === "api") {
      const route = args[1];
      if (route === `repos/${REPOSITORY}`) return { code: 0, stdout: JSON.stringify({ default_branch: defaultBranch }), stderr: "" };
      if (/^repos\/acme\/paywall\/actions\/runs\/\d+$/.test(route)) return { code: 0, stdout: JSON.stringify({ workflow_id: workflowId }), stderr: "" };
      if (route.startsWith(`repos/${REPOSITORY}/actions/workflows/${workflowId}/runs?`)) return { code: 0, stdout: JSON.stringify({ workflow_runs: runs }), stderr: "" };
      const match = /^repos\/acme\/paywall\/actions\/runs\/(\d+)\/artifacts\?/.exec(route);
      if (match) return { code: 0, stdout: JSON.stringify({ artifacts: artifacts[match[1]] ?? [] }), stderr: "" };
    }
    if (args[0] === "run" && args[1] === "download") {
      const directory = args[args.indexOf("--dir") + 1];
      await mkdir(directory, { recursive: true });
      for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected gh call: ${text}`);
  };
  return { gh, calls };
}

const artifact = (runId, overrides = {}) => ({ id: 1, name: BASELINE_ARTIFACT, expired: false, created_at: "2026-11-12T00:00:00Z", workflow_run: { id: runId }, ...overrides });

describe("findBaseline", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-action-baseline-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const base = () => ({ repository: REPOSITORY, defaultBranch: "main", runId: 900, directory: path.join(dir, `d-${Math.random().toString(16).slice(2)}`) });

  it("downloads the artifact of the chosen run, by run id, and returns the file", async () => {
    const { gh, calls } = fakeGh({ runs: [run({ id: 200 })], artifacts: { 200: [artifact(200)] } });
    const input = base();
    const result = await findBaseline({ ...input, gh, log: () => {} });
    assert.ok(result.path?.endsWith("baseline.json"));
    assert.equal(await readFile(result.path, "utf-8"), '{"schema":1}');
    const download = calls.find((args) => args[0] === "run");
    assert.deepEqual(download.slice(0, 3), ["run", "download", "200"]);
    assert.ok(download.includes("--repo") && download.includes(REPOSITORY));
    assert.equal(download[download.indexOf("--name") + 1], BASELINE_ARTIFACT);
  });

  it("asks the API for runs of this workflow on the default branch that succeeded, of any event (it filters the events itself)", async () => {
    const { gh, calls } = fakeGh({ runs: [] });
    await findBaseline({ ...base(), gh, log: () => {} });
    const listing = calls.map((args) => args[1]).find((route) => route?.includes("/workflows/"));
    assert.match(listing, /\/workflows\/4242\/runs\?/);
    assert.doesNotMatch(listing, /event=/);
    assert.match(listing, /branch=main/);
    assert.match(listing, /status=success/);
  });

  describe("a forged baseline from a pull request run is never used", () => {
    it("takes the older trusted run, not the newer forged one, and never asks for the forged run's artifacts", async () => {
      const forged = run({ id: 777, event: "pull_request", head_repository: { full_name: "mallory/paywall" }, created_at: "2026-11-14T00:00:00Z" });
      const trusted = run({ id: 200, created_at: "2026-11-01T00:00:00Z" });
      const { gh, calls } = fakeGh({ runs: [forged, trusted], artifacts: { 777: [artifact(777)], 200: [artifact(200)] } });
      const result = await findBaseline({ ...base(), gh, log: () => {} });
      assert.ok(result.path !== undefined);
      assert.ok(calls.every((args) => !args.join(" ").includes("777")), "run 777 was never mentioned to gh");
      assert.equal(calls.find((args) => args[0] === "run")[2], "200");
    });

    it("finds no baseline when the only artifact named wasit-baseline is from a forged run", async () => {
      const forged = run({ id: 777, event: "pull_request", head_branch: "main", head_repository: { full_name: "mallory/paywall" } });
      const { gh, calls } = fakeGh({ runs: [forged], artifacts: { 777: [artifact(777)] } });
      const result = await findBaseline({ ...base(), gh, log: () => {} });
      assert.equal(result.path, undefined);
      assert.ok(calls.every((args) => args[0] !== "run"), "nothing was downloaded");
    });

    it("ignores an artifact that says it belongs to another run", async () => {
      const { gh, calls } = fakeGh({ runs: [run({ id: 200 })], artifacts: { 200: [artifact(999)] } });
      const result = await findBaseline({ ...base(), gh, log: () => {} });
      assert.equal(result.path, undefined);
      assert.ok(calls.every((args) => args[0] !== "run"));
    });
  });

  it("finds no baseline, and says so, when the chosen run's artifact has expired or is not there", async () => {
    for (const artifacts of [{ 200: [artifact(200, { expired: true })] }, { 200: [] }, { 200: [artifact(200, { name: "something-else" })] }]) {
      const { gh } = fakeGh({ runs: [run({ id: 200 })], artifacts });
      const lines = [];
      const result = await findBaseline({ ...base(), gh, log: (line) => lines.push(line) });
      assert.equal(result.path, undefined);
      assert.match(lines.join("\n"), /no baseline/i);
    }
  });

  it("finds no baseline when there is no successful push run yet (the first run on main)", async () => {
    const { gh } = fakeGh({ runs: [] });
    const result = await findBaseline({ ...base(), gh, log: () => {} });
    assert.equal(result.path, undefined);
  });

  it("takes the newest of several artifacts the run has (a re-run)", async () => {
    const { gh, calls } = fakeGh({
      runs: [run({ id: 200 })],
      artifacts: { 200: [artifact(200, { id: 1, created_at: "2026-11-10T00:00:00Z" }), artifact(200, { id: 2, created_at: "2026-11-11T00:00:00Z" })] },
    });
    await findBaseline({ ...base(), gh, log: () => {} });
    assert.equal(calls.filter((args) => args[0] === "run").length, 1);
  });

  it("finds no baseline, and does not throw, when gh fails at any step", async () => {
    for (const failOn of [`repos/${REPOSITORY}/actions/runs/900`, "/workflows/", "/artifacts", "run download"]) {
      const { gh } = fakeGh({ runs: [run({ id: 200 })], artifacts: { 200: [artifact(200)] }, failOn });
      const lines = [];
      const result = await findBaseline({ ...base(), gh, log: (line) => lines.push(line) });
      assert.equal(result.path, undefined, failOn);
      assert.ok(lines.length > 0, failOn);
    }
  });

  it("finds no baseline when the download leaves no JSON file", async () => {
    const { gh } = fakeGh({ runs: [run({ id: 200 })], artifacts: { 200: [artifact(200)] }, files: { "notes.txt": "x" } });
    const result = await findBaseline({ ...base(), gh, log: () => {} });
    assert.equal(result.path, undefined);
  });

  it("asks the repository for its default branch when the caller does not know it", async () => {
    const { gh, calls } = fakeGh({ defaultBranch: "trunk", runs: [run({ id: 200, head_branch: "trunk" })], artifacts: { 200: [artifact(200)] } });
    const { defaultBranch: _unused, ...rest } = base();
    const result = await findBaseline({ ...rest, gh, log: () => {} });
    assert.ok(result.path !== undefined);
    assert.ok(calls.some((args) => args[1] === `repos/${REPOSITORY}`));
  });

  it("refuses a repository or run id that is not one, before any call", async () => {
    const { gh, calls } = fakeGh({});
    for (const bad of [{ repository: "acme/paywall; id" }, { repository: "x" }, { runId: "9; id" }, { runId: -1 }]) {
      const result = await findBaseline({ ...base(), ...bad, gh, log: () => {} });
      assert.equal(result.path, undefined);
    }
    assert.equal(calls.length, 0);
  });

  it("does not let text from gh start a workflow command in the log", async () => {
    const gh = async () => ({ code: 1, stdout: "", stderr: "\u001b[2J\n::set-output name=x::1" });
    const lines = [];
    await findBaseline({ ...base(), gh, log: (line) => lines.push(line) });
    for (const line of lines.join("\n").split("\n")) assert.ok(!/^\s*(::|##\[)/.test(line), line);
    assert.ok(!lines.join("\n").includes("\u001b"));
  });
});

describe("main, the step as the workflow runs it", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-action-baseline-main-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function env() {
    const eventPath = path.join(dir, "event.json");
    await writeFile(eventPath, JSON.stringify({ repository: { full_name: REPOSITORY, default_branch: "main" } }));
    return {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_RUN_ID: "900",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: path.join(dir, "output.txt"),
      RUNNER_TEMP: dir,
    };
  }

  it("writes path= to the step output when it found a baseline, under the runner's temp directory, and exits 0", async () => {
    const environment = await env();
    const { gh } = fakeGh({ runs: [run({ id: 200 })], artifacts: { 200: [artifact(200)] } });
    assert.equal(await main(environment, { gh, log: () => {} }), 0);
    const output = await readFile(environment.GITHUB_OUTPUT, "utf-8");
    const line = output.split("\n").find((entry) => entry.startsWith("path="));
    assert.ok(line !== undefined, output);
    assert.ok(line.slice("path=".length).startsWith(dir));
  });

  it("writes an empty path= and exits 0 when there is none", async () => {
    const environment = { ...(await env()), GITHUB_OUTPUT: path.join(dir, "output-none.txt") };
    const { gh } = fakeGh({ runs: [] });
    assert.equal(await main(environment, { gh, log: () => {} }), 0);
    assert.match(await readFile(environment.GITHUB_OUTPUT, "utf-8"), /^path=$/m);
  });

  it("exits 0 even when its own environment is wrong", async () => {
    assert.equal(await main({}, { gh: async () => ({ code: 1, stdout: "", stderr: "" }), log: () => {} }), 0);
  });
});

// D-022b option 2 (Najmi, 2026-11-16): the comparison comes from the last green
// run on main, the history from the newest completed run on main, failed or not.
// Written before the code.
describe("two lookups: the green run to compare with, the newest finished run for the history", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-history-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const input = () => {
    const directory = path.join(dir, `d-${Math.random().toString(16).slice(2)}`);
    return { repository: REPOSITORY, defaultBranch: "main", runId: 900, directory, historyDirectory: `${directory}-history` };
  };

  it("takes the history from a newer failed run, and the comparison from the older green one, each by run id", async () => {
    const green = run({ id: 200, created_at: "2026-11-10T10:00:00Z" });
    const red = run({ id: 300, conclusion: "failure", created_at: "2026-11-12T10:00:00Z" });
    const { gh, calls } = fakeGh({ runs: [red, green], artifacts: { 200: [artifact(200)], 300: [artifact(300)] } });
    const result = await findBaseline({ ...input(), gh, log: () => {} });
    assert.equal(result.run, 200);
    assert.ok(result.path?.endsWith("baseline.json"));
    assert.ok(result.history?.endsWith("baseline.json"));
    assert.notEqual(path.dirname(result.history), path.dirname(result.path));
    const downloads = calls.filter((args) => args[0] === "run").map((args) => args[2]);
    assert.deepEqual(downloads.sort(), ["200", "300"]);
  });

  it("downloads once when the newest finished run is the green one", async () => {
    const { gh, calls } = fakeGh({ runs: [run({ id: 200 })], artifacts: { 200: [artifact(200)] } });
    const result = await findBaseline({ ...input(), gh, log: () => {} });
    assert.equal(result.history, result.path);
    assert.equal(calls.filter((args) => args[0] === "run").length, 1);
  });

  it("never takes the history from a cancelled run, a pull request run or a run of a fork", async () => {
    const green = run({ id: 200, created_at: "2026-11-10T10:00:00Z" });
    const newer = { created_at: "2026-11-14T10:00:00Z" };
    for (const forged of [
      run({ ...newer, id: 301, conclusion: "cancelled" }),
      run({ ...newer, id: 302, conclusion: "timed_out" }),
      run({ ...newer, id: 303, event: "pull_request", conclusion: "failure" }),
      run({ ...newer, id: 304, conclusion: "failure", head_repository: { full_name: "mallory/paywall" } }),
    ]) {
      const { gh } = fakeGh({ runs: [forged, green], artifacts: { 200: [artifact(200)], [forged.id]: [artifact(forged.id)] } });
      const result = await findBaseline({ ...input(), gh, log: () => {} });
      assert.equal(result.history, result.path, String(forged.id));
    }
  });

  it("asks the API for the completed runs as well as the successful ones", async () => {
    const { gh, calls } = fakeGh({ runs: [] });
    await findBaseline({ ...input(), gh, log: () => {} });
    const listings = calls.map((args) => args[1]).filter((route) => route?.includes("/workflows/"));
    assert.ok(listings.some((route) => /status=success/.test(route)), listings.join("\n"));
    assert.ok(listings.some((route) => /status=completed/.test(route)), listings.join("\n"));
  });

  it("has a history and no comparison when main never passed but did fail", async () => {
    const red = run({ id: 300, conclusion: "failure" });
    const { gh } = fakeGh({ runs: [red], artifacts: { 300: [artifact(300)] } });
    const result = await findBaseline({ ...input(), gh, log: () => {} });
    assert.equal(result.path, undefined);
    assert.equal(result.run, undefined);
    assert.ok(result.history?.endsWith("baseline.json"));
  });

  it("writes path=, run= and history= to the step output", async () => {
    const temp = await mkdtemp(path.join(dir, "runner-"));
    const environment = {
      RUNNER_TEMP: temp,
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_RUN_ID: "900",
      GITHUB_OUTPUT: path.join(temp, "output.txt"),
    };
    const green = run({ id: 200, created_at: "2026-11-10T10:00:00Z" });
    const red = run({ id: 300, conclusion: "failure", created_at: "2026-11-12T10:00:00Z" });
    const { gh } = fakeGh({ runs: [red, green], artifacts: { 200: [artifact(200)], 300: [artifact(300)] } });
    assert.equal(await main(environment, { gh, log: () => {} }), 0);
    const output = (await readFile(environment.GITHUB_OUTPUT, "utf-8")).split("\n");
    assert.ok(output.includes("run=200"), output.join("\n"));
    const history = output.find((line) => line.startsWith("history="))?.slice("history=".length) ?? "";
    assert.ok(history.startsWith(path.join(temp, "wasit", "history")), history);
  });
});

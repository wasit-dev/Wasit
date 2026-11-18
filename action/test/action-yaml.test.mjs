/**
 * The shape of `action/action.yml` and of the template workflow (spec A4, A8 #1,
 * #8, the attack findings A-A02 and A-A07), held by a YAML parser.
 *
 * This is the only check of the YAML that can run here: there is no runner and
 * no `act`, so a real workflow run is "not yet run". What these tests hold is
 * what a reviewer would look for first: where the token goes, that no input
 * becomes shell text, that the steps after the run always run, and that the
 * template asks for no more than it needs.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { parse } from "yaml";

const ACTION_DIR = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(path.join(ACTION_DIR, file), "utf-8");

const action = parse(read("action.yml"));
const steps = action.runs.steps;
const KEY_NAMES = ["STELLAR_PRIVATE_KEY", "EVM_PRIVATE_KEY", "SVM_PRIVATE_KEY", "MPP_PAYER_SECRET", "COMMITMENT_SECRET_HEX", "WASIT_MAINNET_PAYER_SECRET"];
const stepByName = (name) => {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step !== undefined, `a step named ${name}`);
  return step;
};
const index = (name) => steps.indexOf(stepByName(name));

describe("action.yml", () => {
  it("is a composite action with a name, a description and the five inputs", () => {
    assert.equal(action.runs.using, "composite");
    assert.ok(typeof action.name === "string" && action.name.length > 0);
    assert.ok(typeof action.description === "string" && action.description.length > 0);
    assert.deepEqual(Object.keys(action.inputs).sort(), ["config", "endpoints", "environment", "mainnet", "tier"]);
    assert.equal(action.inputs.config.default, "wasit.config.json");
    assert.equal(action.inputs.tier.default, "read-only");
    for (const [name, input] of Object.entries(action.inputs)) assert.ok(typeof input.description === "string" && input.description.length > 0, name);
    assert.match(action.inputs.tier.description, /payment/);
    assert.match(action.inputs.tier.description, /pull request/);
    assert.match(action.inputs.tier.description, /env: of this step/);
  });

  it("offers no input that carries a key or enables a destructive check", () => {
    assert.ok(!Object.keys(action.inputs).some((name) => /key|secret|dry|destructive|payer/i.test(name)));
  });

  it("has one input about mainnet, mainnet, off by default and refused in this version (B12)", () => {
    assert.deepEqual(Object.keys(action.inputs).filter((name) => /mainnet|pubnet|optin/i.test(name)), ["mainnet"]);
    assert.equal(action.inputs.mainnet.default, "false");
    assert.match(action.inputs.mainnet.description, /^Refused in this version: the mainnet opt-in is not part of it\./);
    assert.match(action.inputs.mainnet.description, /exit 2/);
  });

  it("hands the mainnet input to the step that checks the inputs and to the run step, and to no other", () => {
    const withIt = steps.filter((step) => step.env?.INPUT_MAINNET !== undefined).map((step) => step.name);
    assert.deepEqual(withIt, ["Check the inputs", "Run Wasit"]);
    for (const name of withIt) assert.equal(stepByName(name).env.INPUT_MAINNET, "${{ inputs.mainnet }}");
  });

  it("gives every step a name, and a shell to every step that runs a command", () => {
    for (const step of steps) {
      assert.ok(typeof step.name === "string" && step.name.length > 0, JSON.stringify(step).slice(0, 60));
      if (step.run !== undefined) assert.equal(step.shell, "bash", step.name);
    }
  });

  describe("no script injection (A-A02)", () => {
    it("has no expression inside a run block: inputs and event data reach a script only through env", () => {
      for (const step of steps) {
        if (step.run === undefined) continue;
        assert.ok(!step.run.includes("${{"), `${step.name}: ${step.run}`);
      }
    });

    it("passes the inputs to the scripts through env variables", () => {
      const env = stepByName("Run Wasit").env;
      assert.equal(env.INPUT_CONFIG, "${{ inputs.config }}");
      assert.equal(env.INPUT_ENVIRONMENT, "${{ inputs.environment }}");
      assert.equal(env.INPUT_ENDPOINTS, "${{ inputs.endpoints }}");
      assert.equal(env.INPUT_TIER, "${{ inputs.tier }}");
    });

    it("finds its own files with github.action_path, so it works from any checkout of the repository", () => {
      for (const step of steps) {
        if (step.run === undefined || !/scripts\/|packages\//.test(step.run)) continue;
        assert.equal(step.env?.ACTION_PATH, "${{ github.action_path }}", step.name);
        assert.ok(/"\$ACTION_PATH[/"]/.test(step.run), `${step.name} uses "$ACTION_PATH"`);
      }
    });

    it("quotes every use of a variable that holds a path", () => {
      for (const step of steps) {
        if (step.run === undefined) continue;
        assert.ok(!/(^|[^"{])\$(ACTION_PATH|RUNNER_TEMP)\b/.test(step.run.replace(/"\$(ACTION_PATH|RUNNER_TEMP)[^"]*"/g, "")), step.name);
      }
    });
  });

  describe("the token (A-A02, A-A07)", () => {
    const text = read("action.yml");

    it("has no env at the level of the whole action", () => {
      assert.equal(action.env, undefined);
      assert.equal(action.runs.env, undefined);
    });

    it("is passed as GH_TOKEN, as github.token, to the steps that call gh and to no other", () => {
      const withToken = steps.filter((step) => step.env !== undefined && Object.keys(step.env).some((key) => /token/i.test(key)));
      assert.deepEqual(withToken.map((step) => step.name).sort(), ["Comment on the pull request", "Find the baseline"]);
      for (const step of withToken) {
        assert.deepEqual(Object.keys(step.env).filter((key) => /token/i.test(key)), ["GH_TOKEN"], step.name);
        assert.equal(step.env.GH_TOKEN, "${{ github.token }}", step.name);
      }
    });

    it("never reaches the step that runs the service, nor the install, the report or the checks", () => {
      for (const name of ["Check the runner", "Check the inputs", "Install Wasit", "Run Wasit", "Write the report"]) {
        const step = stepByName(name);
        // The payer key variables these steps blank (below) carry no value.
        const env = Object.fromEntries(Object.entries(step.env ?? {}).filter(([key, value]) => !(KEY_NAMES.includes(key) && value === "")));
        assert.ok(!JSON.stringify({ ...step, env }).match(/token|secret|password/i), name);
      }
    });

    it("refers to no secret and no token by any other name", () => {
      assert.ok(!/secrets\./i.test(text));
      assert.ok(!/GITHUB_TOKEN/.test(text));
      assert.equal((text.match(/github\.token/g) ?? []).length, 2);
    });
  });

  describe("the payer key (screening S-4)", () => {
    it("is blanked in every step but the run step, the steps that use another action too (week 2 check F-1)", () => {
      const others = steps.filter((step) => step.name !== "Run Wasit");
      assert.equal(others.length, steps.length - 1, "the run step is missing");
      assert.ok(others.some((step) => step.uses !== undefined), "no step that uses another action was checked");
      for (const step of others) {
        for (const name of KEY_NAMES) assert.equal(step.env?.[name], "", `${step.name}: ${name}`);
      }
    });

    it("reaches the run step as the workflow gives it", () => {
      const run = stepByName("Run Wasit");
      for (const name of KEY_NAMES) assert.equal(run.env?.[name], undefined, name);
    });

    it("names exactly the key variables core keeps from the service", () => {
      const source = readFileSync(path.join(ACTION_DIR, "..", "packages", "core", "src", "denied-env.ts"), "utf-8");
      const list = source.slice(source.indexOf("DENIED_ENV_NAMES"), source.indexOf("];", source.indexOf("DENIED_ENV_NAMES")));
      assert.deepEqual([...list.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]), KEY_NAMES);
    });
  });

  describe("the order, and what always runs (A8 #8)", () => {
    it("checks the runner and the inputs before it installs anything", () => {
      assert.ok(index("Check the runner") < index("Check the inputs"));
      assert.ok(index("Check the inputs") < index("Install Wasit"));
      assert.ok(index("Install Wasit") < index("Run Wasit"));
    });

    it("finds the baseline before the run, and writes the report, the comment and the upload after it", () => {
      assert.ok(index("Find the baseline") < index("Run Wasit"));
      for (const name of ["Write the report", "Comment on the pull request", "Upload the baseline"]) assert.ok(index("Run Wasit") < index(name), name);
      assert.ok(index("Write the report") < index("Comment on the pull request"));
    });

    it("lets the run step fail the job as it is: no continue-on-error, no condition", () => {
      const run = stepByName("Run Wasit");
      assert.equal(run["continue-on-error"], undefined);
      assert.equal(run.if, undefined);
      assert.equal(run.id, "run");
    });

    it("runs the steps after the run whether it passed or failed, but not when it never started", () => {
      for (const name of ["Write the report", "Comment on the pull request", "Upload the baseline"]) {
        const condition = stepByName(name).if;
        assert.match(condition, /always\(\)/, name);
        assert.match(condition, /steps\.run\.conclusion != 'skipped'/, name);
      }
    });

    it("lets the baseline step and the comment step never fail the job", () => {
      // Their scripts exit 0 whatever gh answers; the job's result is the run's exit code.
      assert.ok(stepByName("Find the baseline").run.includes("baseline.mjs"));
      assert.ok(stepByName("Comment on the pull request").run.includes("comment.mjs"));
    });
  });

  describe("what the steps do", () => {
    it("checks for Linux and for Node 22 or later, and installs no Node", () => {
      const run = stepByName("Check the runner").run;
      assert.match(run, /RUNNER_OS/);
      assert.match(run, /Linux/);
      assert.match(run, /22/);
      assert.match(run, /actions\/setup-node/);
      assert.ok(!steps.some((step) => /setup-node/.test(step.uses ?? "")));
    });

    it("installs from the action's own checkout: npm ci --ignore-scripts, then the three builds in dependency order", () => {
      const run = stepByName("Install Wasit").run;
      assert.match(run, /npm ci --ignore-scripts/);
      const builds = [...run.matchAll(/npm run build -w packages\/(\w+)/g)].map((match) => match[1]);
      assert.deepEqual(builds, ["core", "cli", "server"]);
      assert.match(run, /cd "\$ACTION_PATH\/\.\."/);
    });

    it("runs the CLI through one script, and the report through the same", () => {
      assert.match(stepByName("Run Wasit").run, /scripts\/wasit\.mjs" run\b/);
      assert.match(stepByName("Write the report").run, /scripts\/wasit\.mjs" report\b/);
      assert.match(stepByName("Check the inputs").run, /scripts\/wasit\.mjs" check\b/);
    });

    it("gives the run step the baseline the earlier step found, as env", () => {
      assert.equal(stepByName("Run Wasit").env.BASELINE_PATH, "${{ steps.baseline.outputs.path }}");
      assert.equal(stepByName("Write the report").env.BASELINE_PATH, "${{ steps.baseline.outputs.path }}");
    });

    it("uploads the baseline on a push or a dispatch on the default branch, and on a schedule, never on a pull request", () => {
      const upload = stepByName("Upload the baseline");
      assert.match(upload.if, /github\.event_name == 'push'/);
      assert.match(upload.if, /github\.event_name == 'workflow_dispatch'/);
      assert.match(upload.if, /github\.event_name == 'schedule'/);
      assert.match(upload.if, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
      assert.ok(!/pull_request/.test(upload.if));
      assert.equal(upload.with.name, "wasit-baseline");
    });

    it("hands the report step the history and the run it compares with (D-022b)", () => {
      const report = stepByName("Write the report").env;
      assert.equal(report.HISTORY_PATH, "${{ steps.baseline.outputs.history }}");
      assert.equal(report.BASELINE_RUN, "${{ steps.baseline.outputs.run }}");
    });

    it("comments only on a pull request", () => {
      assert.match(stepByName("Comment on the pull request").if, /github\.event_name == 'pull_request'/);
    });

    it("references every script it runs, and every one of them exists", () => {
      const scripts = new Set(steps.flatMap((step) => [...(step.run ?? "").matchAll(/scripts\/([\w-]+\.mjs)/g)].map((match) => match[1])));
      assert.ok(scripts.size >= 3);
      for (const script of scripts) assert.ok(existsSync(path.join(ACTION_DIR, "scripts", script)), script);
    });
  });

  describe("third-party actions", () => {
    const used = steps.filter((step) => step.uses !== undefined).map((step) => step.uses);

    it("uses only actions/upload-artifact, pinned to a full commit SHA", () => {
      assert.deepEqual(used, ["actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"]);
    });

    it("never names a branch or an invented commit", () => {
      for (const reference of used) assert.match(reference, /@(v\d+|[0-9a-f]{40})$/);
    });
  });
});

describe("the template workflow for builders", () => {
  const text = read("examples/wasit.yml");
  const workflow = parse(text);

  it("asks for contents: read, pull-requests: write and actions: read, and nothing else", () => {
    assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "write", actions: "read" });
  });

  it("never uses pull_request_target, not even in a comment that could be copied", () => {
    assert.ok(!/pull_request_target/.test(text.replace(/#.*$/gm, "")));
    assert.ok(!Object.keys(workflow.on).includes("pull_request_target"));
  });

  it("runs on pull requests and on pushes to main", () => {
    assert.ok("pull_request" in workflow.on);
    assert.deepEqual(workflow.on.push.branches, ["main"]);
  });

  it("names its job Wasit: the job is the check on the pull request", () => {
    const jobs = Object.values(workflow.jobs);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, "Wasit");
    assert.equal(jobs[0]["runs-on"], "ubuntu-latest");
  });

  it("checks out without keeping the token in .git/config, installs Node 22, then calls the Action", () => {
    const [job] = Object.values(workflow.jobs);
    const uses = job.steps.map((step) => step.uses);
    assert.equal(uses[0], "actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    assert.equal(job.steps[0].with["persist-credentials"], false);
    assert.equal(uses[1], "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    assert.equal(String(job.steps[1].with["node-version"]), "22");
    assert.match(uses[2], /^wasit-dev\/wasit\/action@/);
  });

  it("does not invent a version of the Action: it has a placeholder to replace, not a branch or a made-up commit", () => {
    const reference = Object.values(workflow.jobs)[0].steps.at(-1).uses;
    assert.equal(reference, "wasit-dev/wasit/action@<tag-or-commit-sha>");
    assert.match(text, /replace .*<tag-or-commit-sha>/i);
  });

  it("has no expression inside a run block", () => {
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps) if (step.run !== undefined) assert.ok(!step.run.includes("${{"));
  });

  it("passes no secret to the Action by default, and says where a header value would go", () => {
    assert.ok(!/secrets\./.test(text.replace(/#.*$/gm, "")), "no secret is used in the template as it stands");
    assert.match(text, /WASIT_HEADER_/);
  });
});

describe("pinned references and the build commit", () => {
  const FULL_SHA = /^[^@\s]+\/[^@\s]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;

  it("pins every third-party action in action.yml to a full commit SHA, with the version it was read at in a comment", () => {
    const text = read("action.yml");
    for (const step of steps.filter((candidate) => candidate.uses !== undefined)) {
      assert.match(step.uses, FULL_SHA, step.uses);
    }
    assert.match(text, /uses: actions\/upload-artifact@[0-9a-f]{40} # v4\.6\.2/);
  });

  it("pins the checkout and setup-node of the template workflow to full commit SHAs too", () => {
    const workflow = parse(read("examples/wasit.yml"));
    const [job] = Object.values(workflow.jobs);
    assert.match(job.steps[0].uses, FULL_SHA);
    assert.match(job.steps[1].uses, FULL_SHA);
    assert.match(read("examples/wasit.yml"), /# v4\.\d+\.\d+/);
  });

  it("gives the action ref to the steps that run Wasit and write the report, as the build commit, and to no other step", () => {
    for (const name of ["Run Wasit", "Write the report"]) {
      assert.equal(stepByName(name).env?.WASIT_BUILD_COMMIT, "${{ github.action_ref }}", name);
    }
    const others = steps.filter((step) => !["Run Wasit", "Write the report"].includes(step.name));
    for (const step of others) assert.ok(step.env?.WASIT_BUILD_COMMIT === undefined, `${step.name} does not get it`);
  });
});

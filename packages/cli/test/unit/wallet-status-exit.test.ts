/**
 * `wallet status --role <role>` must fail when it could not answer.
 *
 * It exited 0 on an unreadable key, so `wasit wallet status --role x402 &&
 * deploy` went ahead on a key that was never checked, while `--role
 * mpp-channel` exited 2 for the same class of error. With `--role` it now
 * exits 2 whenever the role could not be checked; without it, one unchecked
 * role stays a row in the table.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { walletStatusExitCode } from "../../src/wallet-command.js";

const checked = { configured: true, status: { exists: true, balances: [] } };
const unfunded = { configured: true, status: { exists: false, balances: [] } };
const unreadable = { configured: true, error: "not a valid secret key" };
const lookupFailed = { configured: true, error: "Horizon unreachable" };
const notSet = { configured: false };

describe("walletStatusExitCode", () => {
  it("exits 0 when the one role asked about was checked, funded or not", () => {
    assert.equal(walletStatusExitCode(true, [checked]), 0);
    assert.equal(walletStatusExitCode(true, [unfunded]), 0);
  });

  it("exits 2 when the one role asked about could not be checked", () => {
    assert.equal(walletStatusExitCode(true, [unreadable]), 2);
    assert.equal(walletStatusExitCode(true, [lookupFailed]), 2);
    assert.equal(walletStatusExitCode(true, [notSet]), 2);
  });

  it("keeps exiting 0 without --role, where one unchecked role is a row", () => {
    assert.equal(walletStatusExitCode(false, [checked, unreadable, notSet]), 0);
  });
});

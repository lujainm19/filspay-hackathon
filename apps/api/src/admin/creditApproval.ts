import { ConflictError } from "../lib/errors.js";

/** An operator on one side of a credit's two-person control. */
export interface CreditActor {
  adminUserId: string;
  displayName: string;
}

/**
 * Two-person control: the operator who approves a credit must not be the one
 * who requested it.
 *
 * A4 fix: what was wrong — this compared display names. Why it matters — a
 * name is a label, not an identity: the requester's name is copied onto the
 * request when it's made, but the approver's is read fresh, so after any
 * rename the same person no longer "matches" themselves; and two different
 * staff who share a name block each other. What it broke — the maker-checker
 * rule on credits over 50 BD could be bypassed by one person. HANDOVER says it
 * compares admin user ids; now it does.
 */
export function assertDistinctApprover(requester: CreditActor, approver: CreditActor): void {
  if (approver.adminUserId === requester.adminUserId) {
    throw new ConflictError("self_approval_forbidden");
  }
}

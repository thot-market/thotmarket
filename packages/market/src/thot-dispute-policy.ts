/** Explicit release permission; separate from optional one-in-20 treasury review. */
export const THOT_DISPUTE_REVIEW_POLICY='thot.dispute-review/1';
export const THOT_DISPUTE_REVIEW_TERMS='If a funded purchase enters an onchain dispute, non-conflicted governance reviewers may inspect the exact purchased licensed release until the case closes or its review deadline passes. This grants no access to other traces, private source captures, provider credentials or private brokerage proofs.';
export const THOT_DISPUTE_REVIEW_AUTHORIZATION={policy:THOT_DISPUTE_REVIEW_POLICY,scope:'disputed_purchased_release',recipients:'non_conflicted_governance_reviewers',terms:THOT_DISPUTE_REVIEW_TERMS};

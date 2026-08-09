import { authedFetch } from "./authedFetch";
import { SERVER_HTTP } from "./config";
import type { ApprovalState } from "./tournaments";

/** One invite code and whether it has been spent. Organizer-only: an UNUSED
 *  code is the credential, so this never comes back from a public route. */
export type Invite = {
  code: string;
  /** The entrant that used it; absent while the code is still good. */
  used_by?: string;
};

export type SeatRequest = {
  wallet: string;
  state: ApprovalState;
  /** The applicant's handle, when they have one. Resolved by this route rather
   *  than the tournament view's `labels`, which only covers entrants — and an
   *  applicant awaiting a decision is not one yet. */
  username?: string;
};

/** Mint `count` single-use codes. Organizer-only (403 otherwise). */
export async function mintInvites(tid: string, count: number): Promise<Invite[]> {
  const r = await authedFetch(`${SERVER_HTTP}/tournaments/${tid}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count }),
  });
  if (!r.ok) throw new Error(`mint (${r.status})`);
  return r.json();
}

/** Every code and its state. Organizer-only. */
export async function listInvites(tid: string): Promise<Invite[]> {
  const r = await authedFetch(`${SERVER_HTTP}/tournaments/${tid}/invites`);
  if (!r.ok) throw new Error(`invites (${r.status})`);
  return r.json();
}

/** Ask to be let into an approval-gated tournament. No money moves — the join
 *  is a separate call, and it comes second on purpose (there is no onchain way
 *  to return a rejected applicant's entry before the settle timeout). */
export async function requestSeat(tid: string): Promise<void> {
  const r = await authedFetch(`${SERVER_HTTP}/tournaments/${tid}/requests`, { method: "POST" });
  if (!r.ok) throw new Error(`request (${r.status})`);
}

/** Pending + decided requests. Organizer-only. */
export async function listRequests(tid: string): Promise<SeatRequest[]> {
  const r = await authedFetch(`${SERVER_HTTP}/tournaments/${tid}/requests`);
  if (!r.ok) throw new Error(`requests (${r.status})`);
  return r.json();
}

/** Approve or turn down one applicant. Organizer-only. */
export async function decideRequest(
  tid: string,
  wallet: string,
  approve: boolean,
): Promise<void> {
  const r = await authedFetch(`${SERVER_HTTP}/tournaments/${tid}/requests/${wallet}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approve }),
  });
  if (!r.ok) throw new Error(`decide (${r.status})`);
}

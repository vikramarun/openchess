export const meta = {
  name: 'test-openchess-pr',
  description: 'Test + review an OpenChess PR: CI gates, live money-path E2E, ABI compat, 4-lens review, test-backed verification',
  whenToUse: 'Before merging an OpenChess PR that touches the server, ledger, persistence, contracts or any money path. args: {pr: <number>} or {ref: "<branch>"}; optional liveRef (git ref matching the deployed escrow, default origin/main).',
  phases: [
    { title: 'Runtime', detail: 'CI gates, ABI compat and the live money-path E2E, in a worktree' },
    { title: 'Review', detail: 'four lenses read the diff' },
    { title: 'Verify', detail: 'one verifier per lens refutes or reproduces each finding with a test' },
  ],
}

// ---------------------------------------------------------------- inputs
const a = args || {}
if (!a.pr && !a.ref) throw new Error('pass args {pr: <number>} or {ref: "<branch>"}')
const TARGET = a.pr ? `PR #${a.pr}` : `branch ${a.ref}`
const SLUG = a.pr ? `pr-${a.pr}` : String(a.ref).replace(/[^A-Za-z0-9._-]/g, '-')
const CHECKOUT = a.pr ? `gh pr checkout ${a.pr} --detach` : `git checkout --detach ${a.ref}`
const DIFF = a.pr ? `gh pr diff ${a.pr}` : `git diff origin/main...${a.ref}`
// How a READ-ONLY reviewer sees a file at the PR head without touching the
// shared checkout (which is the user's, and may be on any branch).
const HEAD_FETCH = a.pr ? `git fetch -q origin pull/${a.pr}/head:refs/remotes/wf/${SLUG}` : `git fetch -q origin ${a.ref}:refs/remotes/wf/${SLUG}`
const HEAD_SHOW = `git show refs/remotes/wf/${SLUG}:<path>`
const LIVE_REF = a.liveRef || 'origin/main'
const TOOLS = '.claude/skills/test-openchess/scripts'

const SEVERITY = { P0: 0, P1: 1, P2: 2, P3: 3 }

// ---------------------------------------------------------------- schemas
const RUNTIME_SCHEMA = {
  type: 'object',
  properties: {
    worktree: { type: 'string' },
    head: { type: 'string' },
    ciStatus: { type: 'string', description: 'what `gh pr checks` / the CI run reports, incl. which step failed first' },
    gates: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, status: { type: 'string' }, detail: { type: 'string' } }, required: ['name', 'status'] } },
    abiCompat: { type: 'object', properties: { ran: { type: 'boolean' }, ok: { type: 'boolean' }, failures: { type: 'array', items: { type: 'string' } } }, required: ['ran'] },
    e2e: { type: 'array', items: { type: 'object', properties: { test: { type: 'string' }, status: { type: 'string' }, detail: { type: 'string' } }, required: ['test', 'status'] } },
    envIssues: { type: 'array', items: { type: 'string' }, description: 'failures shown to also occur on main / caused by the local environment' },
  },
  required: ['worktree', 'gates', 'abiCompat', 'e2e'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'short stable slug' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          claim: { type: 'string' },
          failureScenario: { type: 'string', description: 'concrete inputs/state -> wrong outcome, in money terms where it applies' },
          reproduce: { type: 'string', description: 'how a test would demonstrate it' },
        },
        required: ['id', 'severity', 'title', 'file', 'claim', 'failureScenario'],
      },
    },
  },
  required: ['findings'],
}

const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
          regression: { type: 'boolean', description: 'true if shown NOT to happen on main' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          evidence: { type: 'string', description: 'the test or command run and its output, or why it is refuted' },
          patch: { type: 'string', description: 'unified diff of the reproduction test, if one was written' },
        },
        required: ['id', 'verdict', 'evidence'],
      },
    },
  },
  required: ['verdicts'],
}

// ---------------------------------------------------------------- prompts
const RUNTIME_PROMPT = `You are testing ${TARGET} of the OpenChess repo (real USDC settles through it). Follow the
test-openchess skill (.claude/skills/test-openchess/SKILL.md), steps 0-3, exactly.

- The tooling is in THIS checkout at ${TOOLS}; use its absolute path — the PR branch may not contain it.
- Create your own worktree: \`git worktree add --detach .claude/worktrees/wf-${SLUG}-runtime main\`, cd into it,
  run \`${CHECKOUT}\`. Never use the user's main checkout for the branch, and never a production database or chain.
- Record CI's real status (\`gh pr checks\` / \`gh run view <id> --log-failed\` for a PR): which step failed FIRST,
  and therefore which steps never ran in CI.
- Run ci-gates.sh against the worktree. For any web-test failure, run the same test on main before attributing it to
  the branch; report those as envIssues.
- If the diff (\`${DIFF} --name-only\` or equivalent) touches contracts/ or crates/ledger/abi/, run
  abi-compat.sh <worktree> ${LIVE_REF}.
- If it touches crates/server, crates/ledger, crates/persistence or contracts/, run e2e-money.py --repo <worktree>.
- Leave the worktree in place and clean (git status) for the user to inspect; report its path.`

const LENSES = [
  {
    key: 'money-onchain',
    focus: `The contract (contracts/src), the ledger crate, the settlement + tournament outboxes, escrow and pool
lifecycles. Every chain read: what does a transport error or an undecodable return become (None/false/unwrap_or/
cached)? Does the vendored ABI still decode against the DEPLOYED escrow (struct getters gaining fields)? Do
postconditions and "already settled" checks read state that can lag or mis-decode? Can money be locked with no
retry, paid on results nobody played, or made refundable and settleable at once?`,
  },
  {
    key: 'concurrency-lifecycle',
    focus: `Room actors, matchmaking (park/queue/gauntlet/tournament), round dispatch, sweeps, the shutdown path and
every consumer of results_tx / cleanup_tx. State registered early (routing, records, tokens) must be undone on every
failure path after it. Lock scope and ordering; work accepted while the server drains; outcomes from aborts/drains
that get SCORED; counters (round_remaining etc.) that can be left too high or decremented twice.`,
  },
  {
    key: 'client-contract',
    focus: `Every client of any interface the PR changes: apps/web (hand-written ABI fragments in lib/escrow.ts,
components/TournamentClaim.tsx, SponsorPool.tsx, lib/sponsorships.ts; deadline/refund math; endpoints), the native
chess-client (crates/byo-client), the house bot (scripts/house-bot.sh), the repo's scripts that deploy or drive the
contract (onchain-demo.sh, tournament-e2e.py), and DEPLOYMENTS.md's deploy instructions and deploy-order claims.
Does each one still satisfy the new contract, before AND after the contract redeploy?`,
  },
  {
    key: 'fix-regression',
    focus: `Treat the PR description and its comments as hypotheses. For each claimed fix: is it at the root or the
input only, and what does the fix itself break? Are fixes applied symmetrically (park vs queue vs tournament)? Do the
new tests use stand-ins (mock contracts, hand-built state) that hide real behaviour? Would each regression test fail
with its fix reverted? Are docs (CLAUDE.md, DEPLOYMENTS.md) now claiming something the code does not do?`,
  },
]

const reviewPrompt = (lens) => `Review ${TARGET} of the OpenChess repo through ONE lens: ${lens.key}.
${lens.focus}

Read the full diff (\`${DIFF}\`) and the enclosing functions and callers of everything it touches — bugs in
unchanged lines of a touched function are in scope. Read them AT THE PR HEAD, not in the working tree (which may be
on another branch): run \`${HEAD_FETCH}\` once, then \`${HEAD_SHOW}\` for any file (and \`git grep <pattern>
refs/remotes/wf/${SLUG}\` to search). Never check out, switch branches or edit files in this checkout — it is the
user's. Don't build or run anything (another agent is running the test suites). Report only defects with a concrete failure scenario, P0 (money lost/locked or prod down)
to P3, at most 8, most severe first. Return an empty list rather than padding.`

const verifyPrompt = (lens, findings) => `Adversarially verify these ${findings.length} findings about ${TARGET} of
the OpenChess repo (lens: ${lens.key}). You are in a fresh git worktree: run \`${CHECKOUT}\` first.

For EACH finding, first try to REFUTE it from the code. If it survives, reproduce it with a throwaway test (append a
#[tokio::test] to the module's tests, or an integration test under crates/*/tests/; for chain behaviour use Anvil as
crates/ledger's tests do) and run it. If the finding claims or implies a regression, show the same test passing on
main (\`git worktree add --detach <scratch-dir> main\`; main may lack dev-deps the branch added). CONFIRMED needs a
test or command that demonstrates it; PLAUSIBLE means it survived refutation but you could not demonstrate it;
REFUTED says why. Adjust severity if the evidence warrants. Include each reproduction test as a unified diff, then
restore every file — leave your worktree clean, remove any scratch worktree you added (\`git worktree remove
--force <dir>\`), and never commit or push.

Findings:
${JSON.stringify(findings, null, 2)}`

// ---------------------------------------------------------------- run
log(`Testing ${TARGET}; live escrow ABI taken from ${LIVE_REF}`)

const [runtime, reviewed] = await parallel([
  () => agent(RUNTIME_PROMPT, { label: 'runtime: gates + e2e + abi', phase: 'Runtime', schema: RUNTIME_SCHEMA }),
  () => pipeline(
    LENSES,
    (lens) => agent(reviewPrompt(lens), { label: `review: ${lens.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
    async (review, lens) => {
      if (!review) return null // the reviewer died: reported below as a coverage gap, not as "clean"
      const findings = review.findings || []
      if (!findings.length) return { lens: lens.key, findings: [], verdicts: [] }
      const v = await agent(verifyPrompt(lens, findings), {
        label: `verify: ${lens.key} (${findings.length})`,
        phase: 'Verify',
        schema: VERDICTS_SCHEMA,
        isolation: 'worktree',
      })
      return { lens: lens.key, findings, verdicts: (v && v.verdicts) || [] }
    },
  ),
])

if (!runtime) log('The runtime agent returned nothing — CI gates, E2E and ABI compatibility are NOT covered')
const lensResults = (reviewed || []).filter(Boolean)
const merged = lensResults.flatMap((r) =>
  r.findings.map((f) => {
    const v = r.verdicts.find((x) => x.id === f.id)
    return { lens: r.lens, ...f, ...(v ? { verdict: v.verdict, regression: v.regression, severity: v.severity || f.severity, evidence: v.evidence, patch: v.patch } : { verdict: 'UNVERIFIED' }) }
  }),
)
const missingLenses = LENSES.map((l) => l.key).filter((k) => !lensResults.some((r) => r.lens === k))
if (missingLenses.length) log(`No result from lens(es): ${missingLenses.join(', ')} — their area is NOT covered`)
const unverified = merged.filter((f) => f.verdict === 'UNVERIFIED').length
if (unverified) log(`${unverified} finding(s) came back without a verdict`)

const rank = (f) => (f.verdict === 'REFUTED' ? 10 : 0) + (SEVERITY[f.severity] ?? 5)
merged.sort((x, y) => rank(x) - rank(y))

return {
  target: TARGET,
  runtime,
  findings: merged.filter((f) => f.verdict !== 'REFUTED'),
  refuted: merged.filter((f) => f.verdict === 'REFUTED').map((f) => ({ id: f.id, title: f.title, why: f.evidence })),
  coverageGaps: [...(runtime ? [] : ['runtime: gates, e2e, abi-compat']), ...missingLenses],
}

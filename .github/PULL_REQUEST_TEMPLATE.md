## What and why

<!-- What does this change, and what problem does it solve? -->

## How it was tested

<!-- Commands run, and for a bug fix the regression test that fails without it.
     Money-path changes (contract, ledger, settlement, staking, tournaments)
     should also pass .claude/skills/test-openchess/scripts/e2e-money.py. -->

## Checklist

- [ ] CI passes (`bash .claude/skills/test-openchess/scripts/ci-gates.sh` runs it all locally)
- [ ] Docs updated if behaviour they describe changed (README, ARCHITECTURE, docs/, CLAUDE.md)
- [ ] Contract changed? ABIs re-vendored in `crates/ledger/abi/`, and docs/deployments.md says what it means for the live deployment
- [ ] Server changed? Remember merging does not deploy it (`./scripts/deploy-server.sh`)

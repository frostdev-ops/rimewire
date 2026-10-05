# Python parity oracle

`python/board.py` and `python/journal.py` are unchanged copies of the original Crosspane
board, retained exclusively as a test oracle. The old runtime was retired after fixture and
real-document parity passed. These files are excluded from the npm package.

Run `npm test` for portable fixture parity. Opt into read-only real-project comparison with:

```sh
RIMEWIRE_CROSSPANE_REPO=/path/to/Crosspane npm test -- tests/parity.test.ts
```

Tests normalize generation time, tiny filesystem timestamp differences, and the intentional
source/checkout schema change. Completion/reopening behavior is tested separately because
explicit `ready` changes effective status in Rimewire. Existing Crosspane files are never edited.

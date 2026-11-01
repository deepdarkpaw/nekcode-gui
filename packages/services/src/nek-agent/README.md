# nek-agent: session admission and tool projection

## Session binding owner (SR)

`renderer input → adapter binding admission → service lifecycle → v4 snapshot/live stream`

- **SR-1 — One binding owner:** `NekAgentServiceAdapter` owns the mapping from actual
  `workspacePath + sessionId` to the internal service key. `workspaceIdentity` is a
  presentation/transport identity, not a second session key. All active reads,
  conversation subscriptions, legacy resume/read, status actions and commands enter
  `ensureNekSessionBinding`, backed by the adapter's `NekSessionBindings` state machine;
  UI never lists disk paths or starts nek to open history.
- **SR-2 — One lifecycle owner:** `NekAgentService` owns records, processes, locks and
  projectors. Adapter admission shares an in-flight promise by binding key; service
  resume shares one by session path in `NekAgentSessionResumeBase` (the same service
  instance and inherited record/pool state, not a second runtime). These promises hold no accepted conversation
  facts and are removed on completion. Each table admits at most 128 flights; the
  accepted binding table retains its existing 5,000-entry limit.
- **SR-3 — State/order:** absent binding → shared restore flight → disk list lookup →
  `read_session_snapshot` → project trust → process initialization + entries projection
  → publish binding → subscribe/read/command. A binding in service `error` phase is
  re-admitted through that same restore path. Failure is thrown unchanged, no binding
  is published, and a partially initialized process is reclaimed before the flight
  rejects. Next user retry starts a new flight; no rejected promise is cached.
- **SR-4 — Lock lease:** a snapshot locked by another process remains readonly and
  retains the reported `lockedBy` holder. No process is spawned and write admission
  rejects with the existing read-only error. Explicit service restart reuses resume
  and rechecks the lock; it cannot force writable state. Unlocked sessions still use
  nek's own process lock at startup, including races after snapshot inspection.
  Explicit legacy resume may request a locked-binding refresh through the same
  admission, preserving the existing ability to retry after the external lock is
  released; ordinary reads do not implicitly upgrade readonly sessions.
- **SR-5 — Replay/delivery boundary:** desktop initial open and reconnect both invoke
  the same conversation subscribe admission. After resume, the loaded projector
  supplies a full snapshot followed by the existing continuous stream. The renderer
  owns only its projection/watermark and subscription generation. Existing
  `ConversationProjectionStore` error state and `retry()` display/clear failures;
  no new UI state owner, auto-fallback or second reconnect command is introduced.
- **Invalidation:** close/delete remove the binding, including identity aliases;
  dispose rejects new admissions and prevents late restore results from publishing
  bindings. Service disposal tears down the real processes/projectors. A closed pane
  only releases its subscription, not the session.

### Removed migration paths

The legacy `resumeSession` and `bindingSnapshot` disk lookup branches are deleted.
The synchronous adapter `requireBinding` entrypoint is deleted from active read and
command admission. Passive workspace-topic lookup may still inspect already-open
bindings; it must not restore an arbitrary session. The service's direct restart
spawn branch is deleted in favor of resume's authoritative lock decision.

## Tool row owner (TP)

- **TP-1:** `tool:<toolCallId>` is the stable row identity. Assistant call blocks own
  `input`/`inputText` and assistant response identity; execution start owns timing.
  Results own status/output/error/end time. `mergeToolResultRow` updates only those
  result fields on the existing row, rather than reconstructing a row with empty
  inputs. History entries, live result messages and live execution-end events use
  that same pure projection function.
- **TP-2:** a result without an earlier call still creates its completed result row;
  it must not be dropped or converted into an input-streaming placeholder.
- **TP-3:** an execution update without start must apply its provided args and partial
  output immediately. Its row carries both structured input and serialized text.
- Snapshot refresh replays the active branch with the same tool identity. The UI sees
  identical input/output before and after refresh: `ask_question` keeps its question
  count and `ls` keeps its path. Generic row upsert remains whole-row replacement;
  it is not changed to a broad merge that could preserve stale unrelated fields.

## Verification

- `packages/services/test/nekSessionResume.test.ts` exercises the real adapter,
  service, pool, RPC client and projector using deterministic in-memory JSONL IO.
- `packages/services/test/nekToolProjection.test.ts` validates actual v4 frames and
  replays them with the renderer's delta reducer, for historical and live paths.
- `packages/services/test/nekAgentE2E.test.ts` uses real nek + a local HTTP mock,
  disposes the entire service, opens by disk ID in a new service, reads history and
  sends a continuation. It requires `NEK_E2E=1` and `NEK_RPC_WORKTREE` and never uses
  a real model API.

## Reverse verification performed

| Temporarily restored old behavior                                    | Deterministic failure                                                      |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Subscribe only requires an in-memory binding                         | SR-1 reproduces `session ... is not open`                                  |
| Remove binding/path single-flight admission                          | SR-2 observes 4 binding lookups and 2 snapshot restores                    |
| Leave partially initialized records/processes after failure          | SR-3 observes one leaked open record                                       |
| Restart directly spawns instead of checking the snapshot lock        | SR-4 returns writable despite an external holder                           |
| Result rebuilding receives no existing historical tool row           | All six TP-1 history/live parity cases lose structured input               |
| Live upsert creates a placeholder without applying the result/update | TP-2/TP-3 remain `inputStreaming` instead of their actual execution status |

Each change was restored after observing the expected red test, then the full checks
were run against the final implementation. Gate baselines were not changed.

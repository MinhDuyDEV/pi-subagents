# Review `pi-herdr` + `tintinweb/pi-subagents` và roadmap Herdr-native

> Ngày khảo sát: 2026-07-23  
> Package được review: `@minhduydev/pi-subagents` `0.4.0` (working tree hiện tại)  
> Mục tiêu sản phẩm được giữ nguyên: **runtime-only**, không ship agent profile, không chèn policy vào system prompt của consumer.

## 1. Kết luận ngắn

Hướng khác biệt tốt nhất cho package này không phải là sao chép toàn bộ `tintinweb/pi-subagents`, mà là:

> **Một delegation runtime quan sát được bằng Herdr, phục hồi được sau crash, cô lập write-work, và có verification/provenance thật sự máy kiểm tra được.**

Ba kết luận chính:

1. **Giữ phần lõi hiện có** từ fork `pi-task`: foreground/background, JSONL session là nguồn kết quả chuẩn, resume, HerdR/tmux/SDK fallback, runtime-only agent discovery.
2. **Học `pi-herdr` ở boundary với Herdr**: activation gate rõ ràng, client JSON typed, ba primitive tách biệt, lifecycle state chuẩn, preserve focus, abort propagation.
3. **Học `tintinweb/pi-subagents` ở product layer**: `AgentManager`, grouped join, FleetView/conversation viewer, worktree isolation, settings/capability flags và test matrix lớn.

Tuy nhiên, orchestration layer `0.4.0` hiện vẫn là **prototype**, chưa nên quảng bá các bảo đảm “machine-checkable”, “one owner per resource”, “semantic proof”, hay “independent ship gate” như invariant production. Có các lỗi kiến trúc P0 làm những bảo đảm đó chưa đúng end-to-end; chi tiết ở mục 6.

Khuyến nghị release: giữ `0.4.0` ở trạng thái beta/experimental, xử lý P0 rồi mới coi orchestration contract là stable.

---

## 2. Phạm vi và snapshot đã kiểm tra

### Repositories

| Project | Revision đã đọc | Phiên bản |
|---|---|---:|
| `MinhDuyDEV/pi-subagents` | `e0906345ee62d6cfd0198c51f04858404281cc20` + working tree | `0.4.0` |
| `heyhuynhgiabuu/pi-task` | `a56fdc2986c942ec7e61fdb9037a236a7c3d3aae` | `0.3.7` |
| `ogulcancelik/pi-extensions/packages/pi-herdr` | `1fb7e1728b5709b83b5104155a90a4d35bdc6380` | `0.4.0` |
| `tintinweb/pi-subagents` | `c10b1836256e760da75296ccd4e57a77ada1325e` | `0.14.3` |
| Herdr | `e7fc85bfdb51f89488430adbfe5bbced3be79c2f` | `0.7.5` docs/API baseline |
| Pi SDK | local install | `0.81.0` |

### Quy mô và validation hiện tại

| Project | Source TS | Test TS | Test count quan sát được |
|---|---:|---:|---:|
| Package hiện tại | 9,312 LOC | 7,072 LOC | 132 pass (`60` base + `72` orchestration) |
| `tintinweb/pi-subagents` | 8,431 LOC | 12,817 LOC | 750 pass tại snapshot khảo sát |
| `pi-herdr` package | 745 LOC | 269 LOC | 9 tests |

Các lệnh đã chạy sạch trên working tree hiện tại:

```text
npm test       # 132 pass
npm run typecheck
npm run build
npm audit      # 0 vulnerability
npm pack       # chỉ dist/README/LICENSE, khoảng 80 KB packed
```

Test pass là tín hiệu tốt về regression, nhưng hiện chưa có E2E thật giữa Pi ↔ child Pi ↔ Herdr; vì vậy một số test đang chứng minh implementation nội bộ hoạt động theo mock, chưa chứng minh guarantee sản phẩm hoạt động trong runtime thật.

---

## 3. So sánh kiến trúc

| Trục | Package hiện tại | `pi-herdr` | `tintinweb/pi-subagents` |
|---|---|---|---|
| Mục tiêu | Delegation runtime + governance prototype | Điều khiển Herdr cho Pi | Full in-process agent fleet manager |
| Agent profiles | Consumer sở hữu | Không quản lý profile | Built-in + custom profile CRUD |
| Execution | Herdr, tmux, SDK | Herdr CLI | Pi SDK/in-process |
| Herdr visibility | Có pane, nhưng dùng rất ít lifecycle/metadata | First-class | Không có |
| Completion truth | Pi session JSONL + terminal stop reason | Herdr status/read | AgentSession lifecycle/result |
| Durable resume | Có registry/session history | Herdr session state | Persistent sessions tùy chọn |
| Write isolation | Shared cwd + claims prototype | Chỉ topology, không code isolation | Git worktree |
| Parallel completion | Từng follow-up riêng | Agent wait | Async/smart/group join |
| UI | Task widget gọn | Tool renderers gọn | FleetView, widget, conversation viewer, menus |
| Scheduling | Không | Không | Cron/once/interval |
| Cross-extension API | Không ổn định | Không | RPC v2 |
| Governance | Claims, Context Pack, proof, doctor, telemetry | Không | Không |
| Test depth | Khá, thiếu E2E backend | Nhỏ nhưng boundary rõ | Rất lớn, nhiều race/lifecycle cases |

### Định vị nên chọn

Không nên cạnh tranh với tintin bằng checklist feature. Nên tập trung vào bốn invariant:

1. **Observable:** mỗi delegated run có pane/agent identity rõ trong Herdr.
2. **Durable:** parent Pi hoặc Herdr restart không làm mất ownership/result.
3. **Isolated:** parallel writers không dùng chung một dirty worktree nếu cần guarantee.
4. **Verifiable:** execution result, evidence và review là ba state độc lập, có provenance.

---

## 4. “Tinh hoa” nên lấy từ `pi-herdr`

Nguồn chính: [`packages/pi-herdr/index.ts`](https://github.com/ogulcancelik/pi-extensions/blob/1fb7e1728b5709b83b5104155a90a4d35bdc6380/packages/pi-herdr/index.ts).

### 4.1. Gate extension sớm và rõ

`pi-herdr` return ngay nếu không có `HERDR_ENV=1` và `HERDR_PANE_ID`. Không đăng ký tool nửa vời ngoài Herdr.

Áp dụng:

- Tách `HerdrClient` khỏi task core.
- Chỉ bật capability Herdr khi environment + control-plane probe đều hợp lệ.
- Không để child mode vô tình đăng ký control tools.

### 4.2. Ba primitive có boundary sạch

`pi-herdr` tách:

- `herdr_layout`: topology;
- `herdr_pane`: raw terminal process/I/O;
- `herdr_agent`: coding-agent lifecycle.

Điểm quan trọng không phải là copy ba tool vào package này. Điểm quan trọng là **không trộn topology, terminal transport và agent lifecycle trong một interface**.

Interface hiện tại `TerminalBackend` chỉ có `launch/isAlive/send/readTail/close`; nó quá thấp để diễn đạt Herdr agent state, metadata, wait, parent ownership và reconcile. Nên bổ sung một abstraction capability-based:

```ts
interface AgentRuntimeBackend {
  launch(input: LaunchInput): Promise<RunHandle>;
  prompt(handle: RunHandle, text: string, signal?: AbortSignal): Promise<void>;
  inspect(handle: RunHandle): Promise<RuntimeSnapshot>;
  waitForAttention(handle: RunHandle, signal?: AbortSignal): Promise<RuntimeSnapshot>;
  reportMetadata(handle: RunHandle, metadata: TaskMetadata): Promise<void>;
  reconcile(handle: RunHandle): Promise<ReconcileResult>;
  closeOwned(handle: RunHandle): Promise<void>;
}
```

`TerminalBackend` vẫn có thể là adapter cho tmux; Herdr adapter cung cấp capability phong phú hơn.

### 4.3. Structured JSON envelope và typed errors

`pi-herdr`:

- dùng `pi.exec(..., { signal })`;
- kiểm tra exit code/killed/abort;
- parse `{ result, error }`;
- lấy `error.code`/`error.message` thay vì regex trên message tổng quát;
- yêu cầu JSON khi command phải trả JSON.

Áp dụng cho `src/subagent/herdr.ts`:

- tạo một `HerdrClient` duy nhất;
- mọi command có `AbortSignal` và timeout;
- decode đúng envelope, không chấp nhận tùy ý cả raw payload lẫn envelope;
- giữ `code`, `stdout`, `stderr`, `cause` trong `HerdrCommandError`;
- chỉ retry error code transient đã whitelist.

Hiện `runWithRetry()` retry **mọi** lỗi, kể cả invalid argument/not-found; `available()` catch mọi lỗi rồi biến control outage thành “Herdr không available”. Trong `auto`, điều này có thể âm thầm chuyển task sang tmux/SDK dù user đang ở Herdr.

Semantics tốt hơn:

| Tình huống | `auto` nên làm gì |
|---|---|
| Không chạy trong Herdr | fallback tmux/SDK |
| Không có binary Herdr | fallback, nhưng diagnostic một lần |
| Socket/control plane transient outage | bounded retry rồi báo lỗi; không spawn nơi khác âm thầm |
| Explicit `backend=herdr` | fail closed |
| Status `unknown` | uncertain; không coi là completed |

### 4.4. Agent lifecycle là signal, không phải proof

`pi-herdr` chuẩn hóa `idle | working | blocked | done | unknown` và phân biệt các read source `visible | recent | recent-unwrapped | detection`.

Áp dụng:

- Dùng `herdr agent wait` hoặc event `pane.agent_status_changed` để **đánh thức/reconcile**, thay polling 1 giây liên tục.
- Vẫn giữ Pi JSONL `stopReason` là completion truth. Herdr `idle/done` chỉ nói agent đã settled/đáng chú ý, không chứng minh task thành công.
- `blocked` phải là state public và notify một lần, không biến thành timeout.
- `unknown` không bao giờ tự động map thành success.

Đây là hybrid tốt nhất:

```text
Herdr event/wait  -> wake-up nhanh, UI/attention
Pi session JSONL  -> result và stop reason chuẩn
Task store        -> durable orchestration state
```

### 4.5. Preserve focus và geometry-aware layout

`pi-herdr` mặc định `--no-focus` và chọn split direction từ geometry. Đây là UX đúng cho background agent.

Package hiện tại đã `--no-focus`, nhưng grouped workspace chưa có topology policy rõ. Nên có config/task option dạng:

```text
sibling      # mặc định an toàn
right-dock   # child đầu ở bên phải, child sau stack xuống
new-tab
new-workspace
worktree-workspace
```

Không để model tự chọn arbitrary topology nếu user không yêu cầu.

### 4.6. Output truncation chuẩn Pi

`pi-herdr` dùng `truncateTail` với giới hạn chuẩn Pi. Nên dùng cùng utility thay vì tự trả terminal output không giới hạn hoặc tự cắt không đồng nhất.

### Không nên copy từ `pi-herdr`

- Không đăng ký lại `herdr_layout`, `herdr_pane`, `herdr_agent`: package `@ogulcancelik/pi-herdr` đã sở hữu surface đó.
- Không dùng terminal screen text làm authoritative task result.
- Không trao raw pane/layout control cho mọi subagent.
- Không coi status detection là verification.

Package này nên **coexist** với `@ogulcancelik/pi-herdr`: package kia dành cho user/LLM điều khiển Herdr tổng quát; package này dùng internal client để quản lý resource do task runtime sở hữu.

---

## 5. “Tinh hoa” nên lấy từ `tintinweb/pi-subagents`

Nguồn chính tại snapshot [`c10b183`](https://github.com/tintinweb/pi-subagents/tree/c10b1836256e760da75296ccd4e57a77ada1325e).

### 5.1. Một `AgentManager` là owner duy nhất của lifecycle

Điểm mạnh nhất không phải số tool, mà là một manager sở hữu record, start, abort, cleanup, status transition và callbacks. Package hiện tại phân tán state giữa:

- `backgroundTasks`/`foregroundTasks` trong upstream fork;
- task registry/history JSON;
- orchestration `activeRuns` Map;
- lease store;
- context store;
- telemetry event log;
- Herdr `groupedWorkspaces` Map.

Nên gom bằng một `TaskManager`/`TaskRunStore`, trong đó backend, orchestration và UI đều subscribe cùng một state machine.

### 5.2. Group join thay vì completion storm

`tintinweb` có `async`, `smart`, `group` join. Đây là feature rất phù hợp Herdr vì parallel panes thường settle gần nhau.

Nên lấy bản tối giản:

- Mỗi assistant turn tạo một `batchId` cho các task được launch song song.
- Completion được persist ngay nhưng notification debounce khoảng 300–750 ms.
- Khi cả batch settled, gửi **một** follow-up tổng hợp.
- Task blocked/failed nghiêm trọng có thể bypass debounce.
- Không poll từ parent model.

Điều này giảm token, giảm “auto-continue” race và tránh nhiều follow-up turn.

### 5.3. FleetView + conversation viewer

Nên lấy UX, không cần lấy nguyên implementation:

- `/tasks`: list active/recent tasks;
- status, agent, backend, elapsed, claim/worktree, model/tokens;
- Enter mở conversation/result;
- phím steer/stop/focus pane;
- narrow-terminal tests để tránh các issue layout/flicker mà tintin đang gặp.

Herdr đã là visual fleet surface, nên Pi UI chỉ cần “FleetView lite”; không cần duplicate toàn bộ Herdr sidebar.

### 5.4. Worktree isolation

Đây là phần nên ưu tiên cao nhất từ tintin. Claims trong cùng một cwd chỉ là coordination protocol; worktree mới tạo attribution/isolation thực.

Policy đề xuất:

| Task | Default |
|---|---|
| read-only/research | shared cwd |
| một writer foreground, không parallel | shared cwd có thể chấp nhận |
| parallel writers | worktree bắt buộc |
| sensitive-approved | worktree + explicit merge/accept |

Herdr có native `worktree create/list/delete`; nếu version/capability phù hợp, dùng Herdr worktree workspace để vừa isolate git vừa observable. Nếu không, dùng `git worktree` adapter như tintin.

Kết quả writer phải trả:

```ts
{
  baseSha,
  branch,
  worktreePath,
  changedPaths,
  diffDigest,
  verificationReceipts
}
```

Không auto-delete worktree có changes trước khi parent accept/merge.

### 5.5. Settings và feature-gated schema

`tintinweb` chỉ thêm `schedule` parameter khi scheduling enabled để không tốn LLM context. Nên áp dụng nguyên tắc này cho orchestration nâng cao:

- core `task` schema gọn;
- advanced orchestration có feature flag/config;
- tool description không nhồi tất cả policy;
- human commands cho doctor/metrics thay vì luôn expose action lớn cho model.

### 5.6. Stable lifecycle events cho extension khác

Issue [tintinweb/pi-subagents#103](https://github.com/tintinweb/pi-subagents/issues/103) cho thấy scraping text để biết background activity là brittle. Package này nên phát protocol versioned:

```text
pi-subagents:task-created
pi-subagents:task-started
pi-subagents:task-status
pi-subagents:task-settled
pi-subagents:task-verified
pi-subagents:batch-settled
```

Payload tối thiểu: `protocolVersion`, `taskId`, `invocationId`, `batchId`, `phase`, `agentType`, `description`, `backend`, `timestamp`.

### Không nên copy ngay từ tintin

1. **Agent CRUD/bundled agents:** trái với runtime-only ownership hiện tại.
2. **Memory prompt injection:** trái additive-kernel nếu bật mặc định; hãy để consumer profile/Pi skills sở hữu.
3. **Scheduling:** không thuộc critical path của reliable delegation; làm sau durability.
4. **RPC v2:** issue [#156](https://github.com/tintinweb/pi-subagents/issues/156) nêu thiếu recursive ownership và settled cancellation. Nếu làm RPC, bắt đầu từ versioned ownership scope kiểu v3.
5. **Per-spawn extension lifecycle:** issue [#126](https://github.com/tintinweb/pi-subagents/issues/126) mô tả manager/timer leak khi child session dispose không fire `session_shutdown`. Không tạo manager/timer/control tools trong child activation.
6. **Monolithic entrypoint:** `src/index.ts` của tintin khoảng 2,399 LOC; học feature nhưng giữ module boundary nhỏ.

---

## 6. Review package hiện tại: điểm mạnh và P0 blockers

## 6.1. Điểm đang làm tốt

- Runtime-only thật: không còn bundled profiles.
- Agent resolution và override order rõ.
- JSONL session + terminal stop reason là completion source hợp lý hơn `RESULT.md` ceremony.
- Có foreground/background, resume, persistent registry, cleanup ordering và stale-context handling.
- Herdr launch dùng canonical `agent start --kind pi`, sau đó `agent prompt`, preserve focus.
- Handle có `socketPath + paneId + terminalId`; `terminalId` giúp chống pane ID reuse tốt hơn chỉ pane ID.
- Có bounded pane launch serialization/retry.
- Context reference bị giới hạn trong project và có SHA-256 digest.
- Secret redaction, atomic context/lease writes, file lock và local-only artifacts là nền tốt.
- Doctor/metrics/proof/claims là hướng khác biệt có giá trị — nhưng cần biến từ convention thành invariant thật.

## 6.2. P0-1 — “Telemetry” đang đồng thời là state database

`src/orchestration/telemetry.ts` bỏ hẳn event persistence khi `PI_SUBAGENTS_NO_TELEMETRY=1`. Nhưng các flow correctness lại đọc chính event log đó:

- ship gate đếm review;
- `reap` xác định task còn sống;
- doctor tìm task stale/unverified;
- `result` quyết định có revalidate proof;
- metrics và lifecycle cùng dùng một stream.

Hệ quả: opt-out telemetry có thể làm ship gate luôn fail, reaper release nhầm live lease, doctor mất state. Đây không còn là “no metrics”; nó tắt correctness state.

**Fix:** tách hai lớp:

```text
TaskRunStore / journal   # bắt buộc, local, correctness
MetricsSink              # optional, PI_SUBAGENTS_NO_TELEMETRY có thể tắt
```

Journal cần schema version, monotonic sequence, idempotency key và chịu được truncated final line sau crash.

## 6.3. P0-2 — Write guard hiện không chặn built-in `edit`/`write` trong Pi thật

`createTaskExtensionProxy()` chỉ được truyền vào upstream `piTaskExtension`. Upstream chỉ gọi `registerTool()` cho tool `task`; built-in `edit`/`write` không đi qua proxy này. Vì vậy nhánh wrap `definition.name === "edit" || "write"` không chạy trong runtime thật dù unit mock có thể làm nó chạy.

Pi SDK đã có hook đúng: `pi.on("tool_call", ...)` có thể block built-in tool call.

Ngoài ra:

- guard chỉ định bảo vệ parent, không enforce tool của child;
- bỏ sót `apply_patch` và write qua `bash`;
- agent `readonly` hiện vẫn có thể write qua bash;
- `write` claim cho phép `mode: shared`, trái “one owner per resource”;
- caller-controlled `orchestration.id` có thể trùng; acquire bỏ qua conflict cho cùng owner;
- claim path chưa reject `..`, absolute path hay symlink escape.

**Fix ngắn hạn:** dùng global `tool_call` hook cho parent, reject shared write claim, dùng opaque generated invocation owner, canonicalize path.

**Fix thật:** child write tasks chạy trong worktree/sandbox; claim là scheduling/merge ownership, không phải sandbox giả.

## 6.4. P0-3 — Post-hoc write audit không thể attribution trong shared cwd

`src/orchestration/write-claims.ts` chạy:

```text
git status --porcelain --untracked-files=all
```

rồi yêu cầu **mọi** changed path trong repo nằm trong lease của task đang complete. Với hai task parallel có claims disjoint, mỗi task sẽ thấy changes của task kia và fail. Repo đã dirty trước khi task launch cũng gây false positive.

**Fix:** một trong hai:

1. Worktree per writer — ưu tiên;
2. Nếu shared cwd, lưu baseline snapshot theo task (`HEAD`, index/working-tree fingerprints) và chỉ audit delta có attribution; vẫn phải xử lý concurrent mutation race.

Không nên gọi global dirty-tree scan là task write audit.

## 6.5. P0-4 — Evidence pipeline hiện không nhất quán và chưa “semantic”

Các đường đi khác nhau đang validate evidence khác nhau:

- Foreground completion dùng `run.contextPack.evidence`, bỏ qua evidence từ upstream result.
- Background completion dùng `details.evidence`, bỏ qua evidence đã có trong Context Pack.
- `herdr result` lại revalidate Context Pack evidence, không dùng background completion evidence và không truyền `claims`.
- Handoff schema trong `src/orchestration/tool.ts` không có trường `claim`, dù semantic substantiation yêu cầu evidence bind vào claim.
- Upstream `<evidence>` hiện parse thành một string; normalizer không tạo claim binding.

README example để `evidence: []`; với auto evidence-only cho write task, foreground write thông thường sẽ fail vì “No completion evidence”.

Kiểm tra “semantic proof” hiện chỉ yêu cầu file/session chứa **một token dài hơn ba ký tự** từ claim. Session transcript thường đã chứa chính claim trong prompt, nên check có thể pass dù output không chứng minh gì. Hàm đọc file lỗi còn fail-open (`catch => true`). Timestamp cũng do claimant cung cấp.

**Fix:** đổi tên hiện tại thành `evidence-linkage` nếu giữ; không gọi semantic proof. Xây typed evidence receipt do runtime ghi:

```ts
interface EvidenceReceipt {
  id: string;
  producerTaskId: string;
  invocationId: string;
  kind: "test" | "diff" | "file" | "session" | "command-output";
  claimIds: string[];
  artifactPath: string;
  sha256: string;
  observedAt: string;       // runtime-generated
  exitCode?: number;
  commandDigest?: string;
}
```

Một canonical verification function phải được dùng cho foreground, background, result query và doctor.

## 6.6. P0-5 — Background proof chạy sau notification, nên không phải gate

Proxy `sendMessage()` gọi upstream `pi.sendMessage(task-complete)` trước, rồi fire-and-forget `recordBackgroundCompletion()`. Parent có thể nhận và hành động trên self-report trước khi proof/ship gate hoàn tất.

Thêm nữa, `recordBackgroundCompletion()` không kiểm tra `details.phase`/`execution_phase`. Một background child fail nhưng không có proof policy có thể bị ghi thành `task_completed` trong orchestration event log.

**Fix:** orchestration verification phải nằm trước public completion notification:

```text
child settled
  -> persist execution outcome
  -> collect evidence
  -> verify
  -> awaiting_review / accepted / rejected
  -> emit exactly one parent notification
```

Không intercept notification sau khi đã gửi. Vì package là fork in-repo, tích hợp trực tiếp vào `completeTask()`/SDK completion callback thay vì proxy tên/message.

## 6.7. P0-6 — Ship gate chưa chứng minh “independent review”

Hiện tại:

- `reviewer_agent` được parse nhưng không dùng;
- `herdr review` nhận `orchestration_id` do caller tự điền hoặc random;
- cùng một model/agent có thể gọi nhiều lần với ID khác nhau;
- không link review tới reviewer task/session/evidence;
- manual `ship` hard-code `minReviews = 1`, bỏ qua config;
- foreground task không có cơ hội review giữa execution complete và gate;
- thiếu review bị ghi là `task_failed` thay vì `awaiting_review`.

Đây là ceremony, chưa phải independent verification.

**Fix:** review là task record thật có `reviewTaskId`, `reviewerInvocationId`, `subjectTaskId`, subject diff digest/base SHA và verdict receipt. Reviewer phải khác producer scope; runtime tự lấy identity, model không được tự khai. State machine:

```text
execution: completed
verification: pending | passed | failed
review: not_required | awaiting | accepted | rejected
final: accepted | rejected | failed | cancelled
```

`awaiting_review` không phải execution failure.

## 6.8. P0-7 — Active orchestration và grouped workspace chỉ ở memory

`RuntimeState.activeRuns` và `groupedWorkspaces` đều là `Map` process-local.

Hệ quả:

- parent restart giữa task làm completion hook không tìm thấy active run;
- proof/lease cleanup có thể bị bỏ qua;
- group ownership mất sau restart;
- race nếu task cực nhanh complete trước khi `activeRuns.set(taskId, ...)`;
- delete active run trước khi verification hoàn tất làm retry khó;
- cleanup group có thể leak hoặc đóng sai granularity.

**Fix:** persist `TaskRunRecord` trước khi launch; mọi transition idempotent và recoverable. In-memory map chỉ là cache.

## 6.9. P0-8 — Lease không có heartbeat và ownership identity chưa an toàn

Lease default 30 phút nhưng không renew. Task dài hơn TTL âm thầm mất protection. `reap` suy ra liveness từ `task_started.timestamp`, nên task sống lâu có thể bị coi orphan. Caller có thể chọn `orchestration.id`; hai invocation trùng ID được coi cùng owner khi conflict check.

**Fix:**

- runtime sinh `invocationId` opaque; user ID chỉ là correlation label;
- heartbeat/renew lease khi task `working/blocked` còn sống;
- reconcile từ backend + session registry trước khi reap;
- release descendant-first khi cancel;
- report `{ settled, failures }`, không coi cleanup timeout là success.

## 6.10. P0-9 — Child đang có thể nhận orchestration control tool

`src/index.ts` return khi `PI_TASK_TOOL_DISABLED=1`, nhưng `createTaskRuntime()` vẫn gọi `registerHerdrTool(pi)` sau upstream return. Parent tool allowlist lấy toàn bộ tool và chỉ remove `task`; do đó child có thể được cấp tool tên `herdr`.

Tool này cho phép `release`, `reap`, `review`, `ship`, `handoff` và đọc task khác. Điều này vừa phá lease ownership vừa làm independent review không đáng tin.

**Fix:**

- child mode tuyệt đối không đăng ký control-plane/model-facing orchestration tool;
- loại control tools khỏi child allowlist bằng deny-by-default;
- nếu cần child evidence, cung cấp một tool scoped như `task_report_evidence` với token/invocation cố định, chỉ append vào chính task của nó;
- parent/human-only actions phải kiểm tra ownership, không dựa vào string model truyền vào.

---

## 7. Các vấn đề P1 về Herdr integration

### 7.1. Tên tool `herdr` gây hiểu nhầm

Tool hiện tại không điều khiển Herdr; nó điều khiển task orchestration. Trong cùng session với `@ogulcancelik/pi-herdr`, user sẽ thấy:

```text
herdr                 # thực ra task governance
herdr_layout
herdr_pane
herdr_agent
```

Nên rename thành `task_control` hoặc tách model surface nhỏ:

```text
task          # launch/resume
task_status   # query/result nếu thật sự cần cho model
```

Các thao tác `doctor`, `metrics`, `reap`, `release`, `ship` nên ưu tiên human commands:

```text
/tasks
/task <id>
/task-doctor
/task-metrics
/task-stop <id>
```

Nếu cần compatibility, giữ alias `herdr` deprecated một minor release nhưng không expose alias cho child.

### 7.2. Handle Herdr thiếu provenance cần cho reconcile

Handle nên chứa tối thiểu:

```ts
interface HerdrRunHandle {
  backend: "herdr";
  socketPath: string;
  sessionFingerprint?: string;
  parentPaneId: string;
  parentTerminalId: string;
  paneId: string;
  terminalId: string;
  agentName: string;
  workspaceId: string;
  tabId: string;
  topologyOwnerId?: string;
}
```

`terminalId` hiện có là tốt, nhưng cần parent/session/tab/agent identity để reconstruct ownership và tránh collision giữa hai root Pi dùng cùng socket + `workspace_group` string.

### 7.3. Group topology hiện không ổn định

Current group map key chỉ là `socketPath + group`. Nó không namespace theo parent pane, project hay parent Pi session. Task sau lấy pane đầu tiên trong set rồi thường split `right`, dẫn tới bisection lặp chứ không phải vertical stack.

Herdr issue [#1778](https://github.com/ogulcancelik/herdr/issues/1778) xác nhận right-dock multi-agent hiện cần external ownership state. Nếu package hỗ trợ dock, phải làm đầy đủ:

1. lock theo parent pane;
2. first child split parent `right` với ratio cố định;
3. lưu dock anchor + terminal identity;
4. next child split leaf trong dock `down`;
5. validate layout/anchor trước mỗi mutation;
6. nếu anchor mất, fail/fallback rõ — không re-split parent âm thầm;
7. persist ownership để restart reconcile được.

Mặc định nên vẫn là simple sibling hoặc new workspace cho đến khi dock algorithm có E2E.

### 7.4. Dùng agent command cho steering

Fresh launch đã dùng `herdr agent prompt`, nhưng `TerminalBackend.send()` dùng `pane send-text`, sleep 300 ms rồi `send-keys enter`. Với recognized coding agent, nên dùng atomic `agent prompt <pane-or-name> <text>`.

Raw input có thể silently không submit ở một số agent/background pane; xem Herdr issue [#1698](https://github.com/ogulcancelik/herdr/issues/1698). Pi có thể không dính đúng bug Copilot đó, nhưng command semantic vẫn nên đúng layer.

### 7.5. Event-driven cần reconciliation và dedupe

Optional `research/herdr-plugins/attention-broker/` là prototype tốt ở điểm:

- event-driven, không poll model;
- persist-before-delivery;
- dedupe;
- queue khi Root busy;
- namespace theo socket.

Nhưng chưa nên là core completion mechanism:

- identify Root bằng name/workspace, không bằng durable task parent scope;
- gửi prompt bằng `pane run` thay vì task-aware inbox;
- Linux-only manifest;
- không link event tới task record;
- không xử lý Herdr event replay semantics.

Herdr issue [#1270](https://github.com/ogulcancelik/herdr/issues/1270) cho thấy `events.subscribe` từng replay retained events. Client phải snapshot baseline rồi dedupe bằng event identity/revision/timestamp, và luôn reconcile current state trước transition.

Companion plugin tốt nhất chỉ làm **attention bridge** khi parent Pi không polling; task store/JSONL vẫn là truth.

### 7.6. Report metadata vào Herdr

Nên dùng Herdr metadata API để sidebar/agent list hiển thị:

```text
source=pi-subagents
task_id=<id>
invocation_id=<id>
agent_type=<profile>
parent_pane=<id>
phase=working|blocked|verifying|awaiting_review
claim=<short summary>
model=<provider/model>
```

Update metadata theo transition, đặt TTL, clear khi cleanup. Có thể thêm notification khi `blocked`, `verification_failed`, `batch_settled`.

### 7.7. Cross-platform/capability probe

Không chỉ kiểm `path.isAbsolute(socketPath)`. Cần test contract trên:

- macOS/Linux Unix socket;
- WSL;
- native Windows named pipe/socket representation;
- path có spaces/unicode;
- Herdr server restart ở cùng socket path;
- mixed Herdr version.

Probe nên trả capability set, ví dụ `agent.prompt`, `agent.wait`, `pane.report-metadata`, `worktree.create`, thay vì chỉ boolean available.

---

## 8. Code quality/release hygiene

### P1

1. **Hai TypeBox implementation:** base schema import từ `typebox`, orchestration import từ `@sinclair/typebox`, sau đó cast `TSchema`. Nên thống nhất `typebox` + Pi `StringEnum` như `pi-herdr` để tránh type/schema-kind drift và bỏ dependency thừa.
2. **Dependency floor mismatch:** peer yêu cầu Pi/TUI `>=0.81.1`, nhưng dev install hiện là `0.81.0`. CI phải test đúng minimum advertised và latest.
3. **`any` tập trung ở SDK boundary:** `src/subagent/runSdk.ts` và callbacks trong `src/index.ts`. Dùng exported `AgentSession`, `Model`, `ThinkingLevel` types hoặc local narrowed interfaces.
4. **Bare catches:** phân loại expected absence, transient transport và corruption; log structured diagnostic cho cleanup failures. Không swallow proof/state corruption.
5. **README drift:** source có `reap/review/ship` nhưng README action list không đủ; README nói `PI_SUBAGENTS_NO_PROOF=1` skip gate nhưng auto write-proof hiện cố tình không honor; cần document chính xác.
6. **Action duplication:** `record_review` và `review` là hai khái niệm gần nhau nhưng event khác; merge thành typed review receipt API.
7. **Upstream fork maintenance:** ghi upstream SHA trong file/CI và có script kiểm divergence. Hiện phần custom ngoài orchestration chủ yếu là `src/subagent/herdr.ts`; nên tránh tiếp tục sửa monolithic `src/index.ts` nếu có thể.
8. **SemVer:** nhiều guarantee mới trong cùng ngày và contract còn đổi mạnh; dùng prerelease (`0.4.0-beta.x`) cho đến khi migration/state schema rõ.

### P2

- Export một read-only programmatic API/subpath cho integrations, nhưng chỉ sau khi protocol version ổn định.
- Add `engines.node` và support matrix.
- Add package install E2E từ tarball vào clean temp Pi home.
- Add migration/version handling cho `.pi/artifacts/tasks/orchestration/*`.

---

## 9. Kiến trúc đích đề xuất

## 9.1. Ba lớp

```text
┌─────────────────────────────────────────────────────────────┐
│ Product surface                                              │
│ task tool · /tasks · task widget · batch notification        │
├─────────────────────────────────────────────────────────────┤
│ Durable task kernel                                          │
│ TaskManager · RunStore · state reducer · claims · evidence   │
│ review receipts · recovery · lifecycle events                │
├─────────────────────────────────────────────────────────────┤
│ Runtime adapters                                             │
│ HerdrAgentBackend · TmuxBackend · PiSdkBackend · Worktree    │
└─────────────────────────────────────────────────────────────┘
```

Governance không nên wrap upstream bằng tool-name/message-name proxy. Vì đây là in-repo fork, kernel nên gọi trực tiếp lifecycle hooks ở đúng thời điểm.

## 9.2. Task record

```ts
interface TaskRunRecordV1 {
  version: 1;
  taskId: string;
  invocationId: string;       // runtime generated, security/ownership identity
  correlationId?: string;     // caller supplied, không dùng làm authority
  batchId?: string;
  agentType: string;
  description: string;
  cwd: string;

  execution: {
    phase: "allocating" | "starting" | "working" | "blocked" |
           "completed" | "failed" | "cancelled" | "timeout";
    backend: "herdr" | "tmux" | "sdk";
    handle?: RuntimeHandle;
    sessionPath?: string;
    resultDigest?: string;
  };

  verification: {
    phase: "not_required" | "pending" | "passed" | "failed";
    evidenceReceiptIds: string[];
    issues: string[];
  };

  review: {
    phase: "not_required" | "awaiting" | "accepted" | "rejected";
    required: number;
    receiptIds: string[];
  };

  ownership: {
    leaseId?: string;
    claims: ResourceClaim[];
    worktree?: WorktreeHandle;
    baseline?: WorkingTreeBaseline;
  };

  timestamps: {
    createdAt: string;
    startedAt?: string;
    heartbeatAt?: string;
    settledAt?: string;
    finalizedAt?: string;
  };
}
```

### Invariant quan trọng

- Execution complete **không đồng nghĩa** verification pass.
- Verification pass **không đồng nghĩa** review accepted.
- Parent chỉ nhận final-success notification sau required gates.
- Cleanup resource và final notification đều idempotent.
- Mọi authority dùng runtime-generated ID, không dùng string do model tự khai.

## 9.3. Herdr launch flow tối ưu

```text
1. Probe Herdr environment + capabilities.
2. Persist TaskRunRecord(allocating).
3. Acquire/queue claims bằng invocationId.
4. Create worktree nếu writer parallel/sensitive.
5. Chọn topology; create pane/workspace với --no-focus.
6. Persist full handle ngay sau mỗi allocation.
7. herdr agent start <stable-name> --kind pi --pane <id> -- <argv>.
8. Report task metadata vào pane.
9. herdr agent prompt <target> <prompt>.
10. Mark working + heartbeat lease.
11. Herdr wait/event đánh thức; JSONL xác nhận completion.
12. Persist execution outcome.
13. Collect immutable evidence receipts; verify.
14. Nếu cần review: awaiting_review; launch/link reviewer task.
15. Emit one batch-aware final notification.
16. Close only owned pane/workspace; retain changed worktree until accepted.
```

### Stable agent name

Dùng sanitized, deterministic prefix và collision-safe suffix:

```text
pi-task-<short-task-id>-<agent-slug>
```

Store exact returned identity; không reconstruct name khi restore.

---

## 10. Roadmap ưu tiên

## Phase 0 — Correctness freeze (bắt buộc trước stable release)

- [ ] Tách durable state journal khỏi telemetry opt-out.
- [ ] Tích hợp orchestration trực tiếp vào completion path, bỏ post-send gate.
- [ ] Honor execution `failed/cancelled/timeout` trước proof.
- [ ] Persist active run trước launch; recover after restart.
- [ ] Không đăng ký control tool trong child; deny control tools khỏi child allowlist.
- [ ] Thay fake write wrapper bằng Pi `tool_call` hook hoặc bỏ claim guarantee khỏi docs.
- [ ] Reject shared write claim và caller ID làm authority.
- [ ] Thống nhất evidence pipeline; downgrade tên “semantic proof” cho đến khi receipt model hoàn tất.
- [ ] Đổi ship gate thành `awaiting_review`, có reviewer identity thật.
- [ ] Thêm dirty-repo/concurrent-writer regression tests.

## Phase 1 — Herdr-native adapter

- [ ] `HerdrClient` typed envelope/error/capability/abort/timeout.
- [ ] Steering bằng `agent prompt`, status bằng `agent get/wait`.
- [ ] Full persisted Herdr handle + ownership verification.
- [ ] Metadata + blocked/final notification.
- [ ] Classified retry và no-silent-fallback on control outage.
- [ ] E2E với Herdr `0.7.5` trên macOS/Linux; Windows contract tests.

## Phase 2 — Safe parallel writes

- [ ] Herdr native worktree adapter khi capability có sẵn.
- [ ] Git worktree fallback.
- [ ] Diff/base SHA/digest receipts.
- [ ] Explicit accept/merge/retain/cleanup flow.
- [ ] Claim queue + heartbeat + fair wakeup.

## Phase 3 — UX lấy từ tintin

- [ ] Batch/group join.
- [ ] `/tasks` FleetView lite.
- [ ] Conversation/result viewer.
- [ ] Focus/steer/stop commands.
- [ ] Settings/capability flags và compact schema.

## Phase 4 — Optional ecosystem

Chỉ làm sau core stability:

- [ ] versioned lifecycle API cho extension khác;
- [ ] optional attention-broker plugin;
- [ ] scheduling;
- [ ] RPC ownership scopes v3;
- [ ] optional memory/skill integrations do consumer bật rõ ràng.

---

## 11. Test matrix cần thêm

### Real integration/E2E

| Scenario | SDK | tmux | Herdr |
|---|:---:|:---:|:---:|
| foreground success/fail/cancel/timeout | ✓ | ✓ | ✓ |
| background success/fail | ✓ | ✓ | ✓ |
| task completes trước receipt registration | ✓ | ✓ | ✓ |
| parent Pi restart giữa run | ✓ | ✓ | ✓ |
| backend temporarily unavailable | n/a | ✓ | ✓ |
| pane manually closed | n/a | ✓ | ✓ |
| Herdr restart cùng socket path | n/a | n/a | ✓ |
| child blocked rồi resume | ✓ | limited | ✓ |
| grouped launch/close race | n/a | n/a | ✓ |
| prompt contains multiline/unicode/large text | ✓ | ✓ | ✓ |

### Governance/fault injection

- clean repo, pre-dirty repo, staged changes, rename, delete, untracked, symlink;
- two parallel writers disjoint claims;
- overlapping claim queue/fairness;
- duplicate caller correlation ID;
- task dài hơn lease TTL;
- crash giữa acquire → launch, launch → persist, complete → verify, verify → notify;
- partial/corrupt last journal line;
- duplicate completion event/idempotency;
- failed child không bao giờ được metric thành completed;
- proof failure không gửi success notification trước;
- same reviewer/session không thể tự tạo N independent receipts;
- `NO_TELEMETRY` không thay đổi correctness;
- child không thấy `release/reap/review/ship`;
- package co-install với `@ogulcancelik/pi-herdr`;
- tarball install vào empty consumer có `.pi/agents/` riêng.

### Property tests

- claim path normalization/overlap;
- Windows/POSIX paths;
- task state transition legality;
- event reducer idempotency;
- cleanup chỉ đóng resource có matching terminal/session ownership.

---

## 12. Quyết định “adopt / defer / reject”

| Ý tưởng | Quyết định | Lý do |
|---|---|---|
| Typed Herdr client | **Adopt now** | Boundary correctness |
| Herdr status/events | **Adopt now, as wake-up** | Giảm polling; JSONL vẫn là truth |
| Herdr metadata | **Adopt now** | Visibility cao, cost thấp |
| Three primitive separation | **Adopt internally** | Boundary sạch; không copy public tools |
| Group join | **Adopt P3** | Giảm completion storm/token |
| Worktree isolation | **Adopt P2/P0 design** | Cần cho write guarantee thật |
| FleetView lite | **Adopt P3** | UX tốt, không duplicate Herdr quá mức |
| Conversation viewer | **Adopt P3** | Debug/review hữu ích |
| Custom agent CRUD | **Reject** | Consumer sở hữu profiles |
| Bundled agents | **Reject** | Trái runtime-only |
| Default memory injection | **Reject** | Trái additive kernel |
| Scheduling | **Defer** | Không phải reliability core |
| RPC v2 | **Reject** | Thiếu recursive ownership/settlement |
| RPC v3 scopes | **Defer** | Chỉ sau state kernel ổn định |
| Public tool tên `herdr` cho task state | **Rename** | Collision/semantic confusion |
| Token-overlap gọi là semantic proof | **Reject claim** | Không chứng minh semantics |

---

## 13. Sources đáng chú ý

### External code

- [`@ogulcancelik/pi-herdr` source](https://github.com/ogulcancelik/pi-extensions/blob/1fb7e1728b5709b83b5104155a90a4d35bdc6380/packages/pi-herdr/index.ts)
- [`tintinweb/pi-subagents` snapshot](https://github.com/tintinweb/pi-subagents/tree/c10b1836256e760da75296ccd4e57a77ada1325e)
- [`AgentManager`](https://github.com/tintinweb/pi-subagents/blob/c10b1836256e760da75296ccd4e57a77ada1325e/src/agent-manager.ts)
- [`group-join.ts`](https://github.com/tintinweb/pi-subagents/blob/c10b1836256e760da75296ccd4e57a77ada1325e/src/group-join.ts)
- [`worktree.ts`](https://github.com/tintinweb/pi-subagents/blob/c10b1836256e760da75296ccd4e57a77ada1325e/src/worktree.ts)
- [`cross-extension-rpc.ts`](https://github.com/tintinweb/pi-subagents/blob/c10b1836256e760da75296ccd4e57a77ada1325e/src/cross-extension-rpc.ts)

### Upstream issue lessons

- [tintin #103 — reliable background activity API](https://github.com/tintinweb/pi-subagents/issues/103)
- [tintin #126 — child AgentManager/interval leak](https://github.com/tintinweb/pi-subagents/issues/126)
- [tintin #156 — recursive RPC ownership and settling cancellation](https://github.com/tintinweb/pi-subagents/issues/156)
- [Herdr #1778 — external dock ownership state](https://github.com/ogulcancelik/herdr/issues/1778)
- [Herdr #1270 — retained event replay](https://github.com/ogulcancelik/herdr/issues/1270)
- [Herdr #1698 — background prompt/input delivery caveat](https://github.com/ogulcancelik/herdr/issues/1698)

### Local Pi SDK docs đã đối chiếu

- `.../@earendil-works/pi-coding-agent/docs/extensions.md`
- `.../docs/sdk.md`
- `.../docs/tui.md`
- `.../docs/session-format.md`
- `.../docs/packages.md`
- `.../examples/extensions/subagent/`

Đặc biệt, Pi `tool_call` event là API đúng để block built-in tools; `registerTool` proxy không intercept built-ins đã được Pi đăng ký.

---

## 14. Final recommendation

Giữ package nhỏ về policy surface nhưng mạnh về runtime invariants:

```text
Không ship agent profile.
Không inject policy mặc định.
Không clone Fleet Manager toàn phần.
Không gọi convention là guarantee.

Có durable TaskManager.
Có Herdr-native visibility và recovery.
Có worktree cho parallel writes.
Có evidence/review receipt với identity thật.
Có một completion notification đúng thứ tự.
```

Nếu chỉ chọn ba việc tiếp theo, chọn:

1. **Sửa durable state + background completion ordering.**
2. **Worktree isolation và evidence receipt thống nhất.**
3. **Typed Herdr client + metadata/event-driven reconciliation.**

Ba việc này tạo lợi thế khác biệt bền vững hơn scheduling, memory, agent CRUD hay thêm nhiều public actions.

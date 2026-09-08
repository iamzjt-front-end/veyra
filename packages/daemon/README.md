# Local daemon

`@veyraoss/daemon` provides a foreground local coordinator and discovery/client functions. It delegates Project identity/registry/shared state to `@veyraoss/project`. Native/provider execution is introduced through the later typed dispatch API; P0.4 serves lifecycle, health and project listing only.

```sh
ve daemon start                  # foreground; keep this terminal/service running
ve daemon status                 # another terminal/process
ve daemon projects
ve daemon stop
```

All commands accept `--registry <directory>` and `--json`. A service manager can own the foreground process. `SIGINT`/`SIGTERM` request graceful shutdown. No API key or native-agent login is required to start the coordinator.

`startDaemon({ registryRoot, signal })` returns a handle with metadata, `closed`, a cancellation signal and idempotent `stop()`. Separate clients call `daemonStatus`, `daemonProjects` and `stopDaemon`. Tests always supply a disposable registry root.

## Discovery and local trust

One daemon owns a registry root. The process-aware Runtime lock prevents duplicate starts. Non-secret discovery metadata lives at `<registry-root>/daemon/daemon.json`: instance UUID, process owner, canonical registry root, start time and socket location. PID liveness is conservative: live or unknown owners are never killed/replaced based on metadata. Only a provably stopped local owner permits stale recovery. Corrupt metadata is preserved and fails closed.

Connections use a Unix socket, never a TCP/public listener. To fit macOS socket path limits, the socket is under the current user's mode-0700 `/tmp/veyra-<uid>/` directory; its name is derived from the canonical registry root and mode is 0600. Discovery and logs also require private current-user ownership. The trust boundary is the local OS user, not a secret copied from Codex. Other applications running as the same OS user can call the daemon; this is not an isolation boundary against that user. A future bridge must add its own explicit narrow authorization.

Shutdown aborts in-flight listing, closes client sockets, releases the local lease and removes the current instance's discovery/socket. Project/registry data remains untouched. A killed process leaves metadata/lock/socket for conservative recovery on restart. An orphan socket with no verifiable discovery record is preserved for inspection.

Resources are bounded: 32 concurrent clients, 10-second idle timeout, 1-KiB lifecycle requests, 2-MiB responses and 64 log records of bounded messages. Logs are structured JSON Lines at `daemon/daemon.jsonl`, coalesced to one pending disk write and filtered through the existing secret redactor. Raw request text, native credentials, provider configuration and chat histories are never logged or copied.

Supported platforms follow Veyra's macOS/Linux policy; use a local filesystem. Registry/shared engineering state remains owned by Project. The daemon does not create a cloud dependency or a second business-state database.

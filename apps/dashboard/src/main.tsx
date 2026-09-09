import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Button, Dialog } from "@veyraoss/ui";
import { WorkspaceStore } from "./store.js";
import { RunDetail } from "./run-detail.js";
import { WorkspaceView } from "./views.js";
import "@veyraoss/ui/styles.css";
import "./styles.css";

const store = new WorkspaceStore();
let stream: EventSource | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;
function listen() {
  stream?.close();
  clearTimeout(retry);
  if (document.hidden) return;
  stream = new EventSource("/events");
  stream.addEventListener("ready", () => {
    attempts = 0;
    void store.refresh();
  });
  stream.addEventListener("changed", () => {
    void store.refresh();
  });
  stream.onerror = () => {
    stream?.close();
    if (!document.hidden && attempts < 3) retry = setTimeout(listen, 2000 * 2 ** attempts++);
    else if (!document.hidden)
      store.fail(
        new Error(
          "Local event connection was interrupted. Reconnect to refresh your saved evidence.",
        ),
      );
  };
}
async function connect() {
  await store.connect();
  if (!store.snapshot().error) listen();
}
function App() {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [cancel, setCancel] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    const route = () => store.route(location.hash.slice(1));
    const visible = () => {
      if (document.hidden) {
        stream?.close();
        clearTimeout(retry);
      } else void connect();
    };
    const close = () => {
      stream?.close();
      clearTimeout(retry);
      store.close();
    };
    window.addEventListener("hashchange", route);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", close);
    void connect();
    return () => {
      close();
      window.removeEventListener("hashchange", route);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pagehide", close);
    };
  }, []);
  const theme = (value: string) => {
    document.documentElement.dataset.theme = value;
    localStorage.setItem("veyra-theme", value);
  };
  return (
    <>
      <WorkspaceView
        {...state}
        runDetail={
          state.evidence && state.project ? (
            <RunDetail
              evidence={state.evidence}
              projectRoot={state.project.project.root}
              cancel={() => setCancel(true)}
            />
          ) : undefined
        }
        error={
          signedOut
            ? "This window is signed out. Open Veyra again to authorize a new session."
            : state.error
        }
        navigate={(route) => {
          location.hash = route;
        }}
        reconnect={() => {
          attempts = 0;
          void connect();
        }}
        cancel={() => setCancel(true)}
        logout={() => {
          stream?.close();
          clearTimeout(retry);
          void store
            .logout()
            .then(() => setSignedOut(true))
            .catch((error) => store.fail(error));
        }}
        theme={theme}
      />
      <Dialog title="Cancel this run?" open={cancel} onClose={() => setCancel(false)}>
        <p>
          Codex will stop. Changes and verification evidence already saved in your Project will
          remain available.
        </p>
        <div className="v-actions">
          <Button onClick={() => setCancel(false)}>Keep working</Button>
          <Button
            variant="danger"
            onClick={() => {
              setCancel(false);
              void store.cancel();
            }}
          >
            Cancel run
          </Button>
        </div>
      </Dialog>
    </>
  );
}
const theme = localStorage.getItem("veyra-theme");
if (theme && ["light", "dark", "system"].includes(theme))
  document.documentElement.dataset.theme = theme;
createRoot(document.getElementById("root") as HTMLElement).render(<App />);

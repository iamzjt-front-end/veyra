import { Brand, Button, Icon, Status } from "@veyraoss/ui";
export interface LauncherState {
  status: "Ready" | "Working" | "Needs attention";
  project?: string;
  allowed: boolean;
  error?: boolean;
}
export function LauncherView({
  state,
  open,
  diagnostics,
}: {
  state: LauncherState;
  open: () => void;
  diagnostics: () => void;
}) {
  return (
    <main className="v-launcher">
      <header>
        <Brand />
        <Status tone={state.status === "Needs attention" ? "warning" : "accent"}>
          {state.status}
        </Status>
      </header>
      <Button
        variant="primary"
        className="v-launcher-open"
        disabled={!state.allowed}
        onClick={open}
      >
        Open Veyra <Icon name="panel" />
      </Button>
      <section>
        <span className="v-eyebrow">Project</span>
        <p>{state.project ?? "Choose a Project in Veyra"}</p>
      </section>
      {!state.allowed && <p className="v-caption">Open chatgpt.com to use the Side Panel.</p>}
      {state.error && (
        <p role="alert" className="v-caption">
          The panel could not open. Reopen it from this conversation.
        </p>
      )}
      <footer>
        <Button variant="ghost" onClick={diagnostics}>
          Diagnostics <Icon name="chevron" />
        </Button>
        <span>Experimental</span>
      </footer>
    </main>
  );
}

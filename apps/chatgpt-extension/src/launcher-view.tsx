import { useI18n } from "@veyraoss/ui";
import { Brand, Button, Icon, Status, LanguageSelect } from "@veyraoss/ui";
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
  const { t } = useI18n();
  return (
    <main className="v-launcher">
      <header>
        <Brand />
        <Status tone={state.status === "Needs attention" ? "warning" : "accent"}>
          {t(state.status)}
        </Status>
      </header>
      <Button
        variant="primary"
        className="v-launcher-open"
        disabled={!state.allowed}
        onClick={open}
      >
        {t("Open Veyra")}
        <Icon name="panel" />
      </Button>
      <section>
        <span className="v-eyebrow">{t("Project")}</span>
        <p>{state.project ?? t("Choose a Project in Veyra")}</p>
      </section>
      {!state.allowed && (
        <p className="v-caption">{t("Open chatgpt.com to use the Side Panel.")}</p>
      )}
      {state.error && (
        <p role="alert" className="v-caption">
          {t("The panel could not open. Reopen it from this conversation.")}
        </p>
      )}
      <footer>
        <Button variant="ghost" onClick={diagnostics}>
          {t("Diagnostics")}
          <Icon name="chevron" />
        </Button>
        <LanguageSelect />
      </footer>
    </main>
  );
}

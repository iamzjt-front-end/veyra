import { useState } from "react";
import { Button, PathText, useI18n } from "@veyraoss/ui";
import type { NativeConversation } from "@veyraoss/protocol";
import type { PanelSnapshot } from "./panel-store.js";

export function ConversationPicker({
  state,
  discover,
  select,
}: {
  state: PanelSnapshot;
  discover(search?: string, more?: boolean): void;
  select(conversation: NativeConversation): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  return (
    <section className="v-codex-picker">
      <Button
        disabled={state.busy}
        onClick={() => {
          if (!open && !state.codexChoices) discover();
          setOpen(!open);
        }}
      >
        {t("Choose an existing Codex task")}
      </Button>
      {state.nativeConversation && (
        <div className="v-native-target">
          <span className="v-eyebrow">{t("Selected Codex task")}</span>
          <strong>{state.nativeConversation.title}</strong>
          <PathText path={state.nativeConversation.root} />
        </div>
      )}
      {open && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              discover(search);
            }}
          >
            <label htmlFor="codex-search">{t("Search Codex task titles")}</label>
            <input
              id="codex-search"
              maxLength={128}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Button type="submit" disabled={state.discovering}>
              {t("Search")}
            </Button>
          </form>
          <p className="v-caption">
            {t(
              "Only titles and folders are listed. Binding registers the selected folder as a Veyra Project; chat history stays in Codex.",
            )}
          </p>
          <div className="v-codex-choices" aria-live="polite">
            {state.discovering && <p>{t("Loading Codex tasks")}</p>}
            {!state.discovering && state.codexChoices?.length === 0 && (
              <p>{t("No matching named Codex tasks")}</p>
            )}
            {state.codexChoices?.map((choice) => (
              <button
                type="button"
                key={choice.id}
                disabled={state.busy}
                aria-pressed={state.nativeConversation?.id === choice.id}
                onClick={() => {
                  select(choice);
                  setOpen(false);
                }}
              >
                <strong>{choice.title}</strong>
                <PathText path={choice.root} />
              </button>
            ))}
          </div>
          {!!state.codexCursor && (
            <Button disabled={state.discovering} onClick={() => discover(search, true)}>
              {t("More Codex tasks")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

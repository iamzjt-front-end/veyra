import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceView } from "../src/views.js";
import { controlFixture } from "./fixtures.js";
import "@veyraoss/ui/styles.css";
import "../src/styles.css";
const name = location.pathname.split("/").at(-1) || "overview";
const fixture = controlFixture(name);
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") ?? "light";
function Fixture() {
  const [route, navigate] = useState(fixture.route);
  return (
    <WorkspaceView
      {...fixture}
      route={route}
      navigate={navigate}
      reconnect={() => {}}
      cancel={() => {}}
      logout={() => {}}
      theme={(theme) => {
        document.documentElement.dataset.theme = theme;
      }}
    />
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);

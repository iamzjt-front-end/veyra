import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { Icon, type IconName } from "../icons/index.js";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
export type StepState = "pending" | "running" | "passed" | "failed" | "paused" | "needs-attention";
const cx = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" ");
export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button type="button" className={cx("v-button", `v-button-${variant}`, className)} {...props} />
  );
}
export function IconButton({
  icon,
  label,
  ...props
}: Omit<Parameters<typeof Button>[0], "children"> & { icon: IconName; label: string }) {
  return (
    <Button
      variant="ghost"
      {...props}
      className={cx("v-icon-button", props.className)}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} />
    </Button>
  );
}
export function StatusDot({ tone = "neutral" }: { tone?: Tone }) {
  return <span className={`v-dot v-tone-${tone}`} aria-hidden="true" />;
}
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`v-badge v-tone-${tone}`}>
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}
export function Status({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span role="status" className={`v-status v-tone-${tone}`}>
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}
export function Surface({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cx("v-surface", className)} {...props} />;
}
export function Divider() {
  return <hr className="v-divider" />;
}
export function CodeText({ children }: { children: ReactNode }) {
  return <code className="v-code">{children}</code>;
}
export function PathText({ path }: { path: string }) {
  return (
    <span className="v-path" title={path}>
      {path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~")}
    </span>
  );
}
export function Select({
  label,
  options,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <div className="v-field">
      <label htmlFor={id}>{label}</label>
      <div className="v-select-wrap">
        <select id={id} {...props}>
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="down" />
      </div>
    </div>
  );
}
export function EmptyState({
  icon = "folder",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="v-empty">
      <span className="v-empty-icon">
        <Icon name={icon} />
      </span>
      <h2>{title}</h2>
      <div className="v-secondary">{children}</div>
      {action}
    </div>
  );
}
export function ErrorState({
  title = "Veyra needs attention",
  children,
  action,
}: {
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="v-error" role="alert">
      <Icon name="warning" />
      <div>
        <h2>{title}</h2>
        <div className="v-secondary">{children}</div>
        {action && <div className="v-actions">{action}</div>}
      </div>
    </section>
  );
}
export function Skeleton({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="v-skeleton">
      <span />
      <span />
      <span />
    </div>
  );
}
export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="v-progress">
      <label>
        {label}
        <progress aria-label={label} value={value} max={100} />
      </label>
    </div>
  );
}
export interface WorkflowStep {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
  trailing?: string;
}
const stepLabels: Record<StepState, string> = {
  pending: "Pending",
  running: "Working",
  passed: "Passed",
  failed: "Failed",
  paused: "Paused",
  "needs-attention": "Needs attention",
};
export function Stepper({
  steps,
  horizontal = false,
}: {
  steps: WorkflowStep[];
  horizontal?: boolean;
}) {
  return (
    <ol className={cx("v-stepper", horizontal && "v-stepper-horizontal")} aria-label="Workflow">
      {steps.map((step) => (
        <li
          key={step.id}
          data-state={step.state}
          aria-current={step.state === "running" ? "step" : undefined}
        >
          <span className="v-step-symbol" aria-hidden="true">
            {step.state === "passed" ? (
              <Icon name="check" />
            ) : step.state === "failed" ? (
              <Icon name="close" />
            ) : step.state === "paused" ? (
              <Icon name="pause" />
            ) : (
              <span />
            )}
          </span>
          <div className="v-step-content">
            <div className="v-step-heading">
              <span>{step.label}</span>
              <span className="v-step-trailing">{step.trailing ?? stepLabels[step.state]}</span>
            </div>
            {step.detail && <p>{step.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
export function Collapsible({
  title,
  children,
  open = false,
}: {
  title: ReactNode;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="v-collapsible" open={open || undefined}>
      <summary>
        <Icon name="chevron" />
        {title}
      </summary>
      <div className="v-collapsible-content">{children}</div>
    </details>
  );
}
export function Tabs({
  items,
  value,
  onChange,
  children,
}: {
  items: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  children: ReactNode;
}) {
  const prefix = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="v-tabs">
      <div role="tablist" aria-label="Run evidence">
        {items.map((item, index) => (
          <button
            type="button"
            key={item.id}
            role="tab"
            id={`${prefix}-${item.id}`}
            aria-selected={value === item.id}
            aria-controls={`${prefix}-panel`}
            tabIndex={value === item.id ? 0 : -1}
            ref={(node) => {
              refs.current[index] = node;
            }}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % items.length
                  : event.key === "ArrowLeft"
                    ? (index + items.length - 1) % items.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : -1;
              if (next >= 0 && items[next]) {
                event.preventDefault();
                onChange(items[next].id);
                refs.current[next]?.focus();
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA panels need a keyboard focus target.
        tabIndex={0}
        id={`${prefix}-panel`}
        aria-labelledby={`${prefix}-${value}`}
        className="v-tab-panel"
      >
        {children}
      </div>
    </div>
  );
}
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="v-tooltip" aria-describedby={id}>
      {children}
      <span role="tooltip" id={id}>
        {label}
      </span>
    </span>
  );
}
export function Dialog({
  open,
  title,
  onClose,
  children,
  drawer = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    else if (!open && dialog?.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={cx("v-dialog", drawer && "v-drawer")}
      aria-labelledby={id}
      onCancel={onClose}
      onClose={onClose}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </header>
      {children}
    </dialog>
  );
}
export function Drawer(props: Omit<Parameters<typeof Dialog>[0], "drawer">) {
  return <Dialog {...props} drawer />;
}
export function Toast({ message }: { message: string }) {
  return (
    <div role="status" className="v-toast" hidden={!message}>
      <Icon name="check" />
      {message}
    </div>
  );
}
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [message, setMessage] = useState("");
  return (
    <span className="v-copy">
      <IconButton
        icon="copy"
        label={label}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => setMessage("Copied"),
            () => setMessage("Copy unavailable"),
          );
        }}
      />
      <span role="status" className="v-caption">
        {message}
      </span>
    </span>
  );
}
export function RunStatus({ status }: { status: string }) {
  const labels: Record<string, [string, Tone]> = {
    completed: ["Completed", "success"],
    failed: ["Needs attention", "danger"],
    running: ["Working", "accent"],
    queued: ["Waiting for Codex", "neutral"],
    paused: ["Paused", "warning"],
    cancelled: ["Cancelled", "neutral"],
    interrupted: ["Needs attention", "warning"],
  };
  const [label, tone] = labels[status] ?? ["Waiting", "neutral"];
  return <Badge tone={tone}>{label}</Badge>;
}
export function AgentStatus({ state }: { state: "ready" | "working" | "unavailable" | "waiting" }) {
  return (
    <Status
      tone={
        state === "unavailable"
          ? "warning"
          : state === "working" || state === "ready"
            ? "accent"
            : "neutral"
      }
    >
      Codex ·{" "}
      {
        { ready: "Ready", working: "Working", unavailable: "Unavailable", waiting: "Waiting" }[
          state
        ]
      }
    </Status>
  );
}
export function VerificationStatus({
  status,
}: {
  status: "passed" | "failed" | "not_run" | "running";
}) {
  return (
    <Status
      tone={
        status === "passed"
          ? "success"
          : status === "failed"
            ? "danger"
            : status === "running"
              ? "accent"
              : "neutral"
      }
    >
      {{ passed: "Passed", failed: "Failed", not_run: "Not run", running: "Checking" }[status]}
    </Status>
  );
}

export function Dropdown({
  label,
  icon = "down",
  items,
  onSelect,
}: {
  label: string;
  icon?: IconName;
  items: { id: string; label: string }[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null),
    id = useId();
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    root.current?.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus();
  };
  return (
    <div className="v-dropdown" ref={root}>
      <IconButton
        icon={icon}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      />
      <div
        id={id}
        role="menu"
        aria-label={label}
        hidden={!open}
        className="v-dropdown-menu"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const buttons = [
              ...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
            ];
            const current = buttons.indexOf(document.activeElement as HTMLElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }
        }}
      >
        {items.map((item) => (
          <button
            type="button"
            role="menuitem"
            key={item.id}
            onClick={() => {
              onSelect(item.id);
              close();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

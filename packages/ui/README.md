# Veyra UI

Private shared React presentation library for the Chrome Side Panel and Local Control Center. It contains no transport, execution, provider authentication or browser conversation code.

Import `@veyraoss/ui/styles.css` once and set `class="v-ui"` on the application root. Semantic colors, spacing, type, radius, elevation and motion are shared. `data-theme="light|dark"` overrides the OS theme. Native controls, dialog focus trapping, arrow-key tabs, visible focus and reduced motion are built in. Idle states have no looping animation or timers.

UI renders passed evidence only when its caller supplies it; unknown status never becomes success. Future data adapters belong to the surface, not to this package.

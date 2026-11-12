// The app's tsconfig keeps JSX as "preserve" (Next compiles it), so the test runner's own transform
// falls back to the classic runtime and needs React in scope. Import this before any component.
import * as React from "react";

(globalThis as { React?: typeof React }).React = React;

// The project's tsconfig uses `jsx: preserve` (Next compiles JSX itself), so under `tsx --test`
// JSX becomes React.createElement(...). Import this module FIRST in any test that renders
// components, so the global exists before module-level JSX (e.g. the legal documents) runs.
import * as React from "react";

(globalThis as unknown as { React: typeof React }).React = React;

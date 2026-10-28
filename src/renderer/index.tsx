import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource-variable/spline-sans-mono";
import "./styles.css";
import { App } from "./App";

// macOS hides the title bar, so the traffic lights float over the page and
// the header must leave room for them (and become the drag handle).
document.documentElement.dataset.os = /Mac OS X/.test(navigator.userAgent) ? "macos" : "other";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

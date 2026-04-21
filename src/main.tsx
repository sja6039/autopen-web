/**
 * main.tsx — React application entry point.
 *
 * Mounts the root <App /> component into the #root div defined in index.html.
 * StrictMode is kept enabled to surface accidental side-effects during
 * development; it has no effect in production builds.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

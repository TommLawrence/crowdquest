import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./shell/styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("App root element is missing.");
}

const Page = window.location.pathname === "/demo"
  ? lazy(() => import("./demo/DemoPage.js").then(({ DemoPage }) => ({ default: DemoPage })))
  : lazy(() => import("./shell/App.js").then(({ App }) => ({ default: App })));

createRoot(root).render(
  <React.StrictMode>
    <Suspense fallback={null}><Page /></Suspense>
  </React.StrictMode>,
);
